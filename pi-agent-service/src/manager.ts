/**
 * AgentManager — central orchestrator for the agent service.
 *
 * Owns all agent sessions, message router, trace log, health/cutoff monitors,
 * and subscription manager. Exposes a transport-agnostic API that protocol
 * adapters call.
 *
 * References: assets [i5eisc9o], [0osnjjl4], [ik1yp2tc]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  codingTools,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { type AgentToolCallbacks, buildAgentTools } from "./agent-tools.js";
import { CutoffMonitor } from "./cutoff.js";
import { HealthMonitor } from "./health.js";
import { buildMessageOverview, buildSystemPrompt, type PromptBuilderDeps } from "./prompt-builder.js";
import { MessageRouter, type SendMessageOpts } from "./router.js";
import { SettingsLoader } from "./settings.js";
import { type SubscriptionEvent, SubscriptionManager } from "./subscriptions.js";
import { type TraceQueryOpts, TraceWriter } from "./trace.js";
import type {
  AclRule,
  AgentConfig,
  AgentState,
  AgentSummary,
  EventFilter,
  ManagedAgent,
  Message,
  MessageResult,
  Settings,
  ThreadSummary,
  TraceEntry,
} from "./types.js";

export interface AgentManagerOptions {
  projectRoot: string;
  settingsPath?: string;
}

export class AgentManager {
  private agents: Map<string, ManagedAgent> = new Map();
  private startedAt: number = Date.now();

  private constructor(
    private projectRoot: string,
    public readonly settings: SettingsLoader,
    public readonly trace: TraceWriter,
    public readonly router: MessageRouter,
    public readonly health: HealthMonitor,
    public readonly cutoff: CutoffMonitor,
    public readonly subscriptions: SubscriptionManager,
  ) {}

  /**
   * Create and initialize an AgentManager.
   */
  static async create(opts: AgentManagerOptions): Promise<AgentManager> {
    const settings = await SettingsLoader.create(opts.projectRoot, opts.settingsPath);
    const s = settings.getSettings();

    const tracePath = path.isAbsolute(s.service.trace_file)
      ? s.service.trace_file
      : path.join(opts.projectRoot, s.service.trace_file);

    const trace = await TraceWriter.create(tracePath);
    const router = new MessageRouter(trace, settings);
    const health = new HealthMonitor(trace);
    const cutoffMonitor = new CutoffMonitor(trace);
    const subscriptions = new SubscriptionManager();

    const manager = new AgentManager(opts.projectRoot, settings, trace, router, health, cutoffMonitor, subscriptions);

    // Wire health/cutoff events to subscriptions
    health.onHealthChange((event) => {
      const entry = trace.append({
        type: "agent_health",
        agent: event.agent,
        from: event.from,
        to: event.to,
      } as any);
      subscriptions.match(entry);
    });

    cutoffMonitor.onWarning((event) => {
      // Already traced in cutoff monitor, just match subscriptions
      const entry: TraceEntry = {
        id: "cutoff-sub",
        ts: new Date().toISOString(),
        type: "context_warning",
        agent: event.agent,
        percent: event.percent,
        level: event.level,
      };
      subscriptions.match(entry);
    });

    // Trace service start
    trace.append({ type: "service_started" } as any);

    // Recovery from existing trace
    const existingEntries = trace.readAll();
    if (existingEntries.length > 1) {
      // more than just the service_started we just wrote
      router.restoreFromTrace(existingEntries);
      const pendingMessages = existingEntries.filter(
        (e) => e.type === "message" && (e as any).status === "queued",
      ).length;
      trace.append({
        type: "service_recovered",
        recoveredAgents: [],
        pendingMessages,
      } as any);
    }

    // Auto-spawn agents with auto_spawn=true
    for (const config of settings.getAllAgentConfigs()) {
      if (config.auto_spawn) {
        await manager.spawnAgent(config.name).catch((err) => console.error(`Auto-spawn ${config.name} failed: ${err}`));
      }
    }

    return manager;
  }

  // ─── Agent Lifecycle ──────────────────────────────────────────

  async spawnAgent(name: string): Promise<void> {
    if (this.agents.has(name) && this.agents.get(name)?.session) {
      throw new ManagerError("ALREADY_RUNNING", `Agent ${name} is already running`);
    }

    const config = this.settings.getAgentConfig(name);
    if (!config) {
      throw new ManagerError("NOT_FOUND", `Agent ${name} not found in settings`);
    }

    // Create SDK session
    const authStorage = AuthStorage.create();
    const modelRegistry = new ModelRegistry(authStorage);
    const model = getModel(config.provider as any, config.model as any);

    const promptDeps = this.getPromptBuilderDeps();
    const toolCallbacks = this.getToolCallbacks(name);
    const customTools = buildAgentTools(name, this.router, this.trace, toolCallbacks);

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
    });

    // Resolve extension paths from agent config
    const extensionPaths = this.resolveExtensionPaths(config.extensions);

    const loader = new DefaultResourceLoader({
      cwd: this.projectRoot,
      agentDir: path.join(this.projectRoot, ".pi", "agent-sessions", name),
      settingsManager,
      additionalExtensionPaths: extensionPaths,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPromptOverride: () => buildSystemPrompt(name, promptDeps),
    });
    await loader.reload();

    const tools = config.coding_tools ? codingTools : [];

    const { session } = await createAgentSession({
      cwd: this.projectRoot,
      model,
      thinkingLevel: config.thinking as any,
      authStorage,
      modelRegistry,
      tools,
      customTools,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
    });

    // Create managed agent
    const managed: ManagedAgent = {
      name,
      config,
      session,
      status: "online-idle",
      health: "healthy",
      queue: [],
      hardSteering: false,
      politeWarned: false,
      lastTokenTime: Date.now(),
      spawnedAt: Date.now(),
      unsubscribe: null,
    };

    // Subscribe to session events
    const unsub = session.subscribe((event) => {
      this.handleSessionEvent(name, event);
    });
    managed.unsubscribe = unsub;

    this.agents.set(name, managed);

    // Trace
    const entry = this.trace.append({
      type: "agent_spawned",
      agent: name,
      config: { provider: config.provider, model: config.model },
    } as any);
    this.subscriptions.match(entry);

    // State transition
    this.transitionState(name, "offline", "online-idle");

    // Drain queued messages
    const queuedMsg = this.router.drainQueue(name);
    if (queuedMsg) {
      const overview = this.buildAgentMessageOverview(name, queuedMsg);
      await session.prompt(overview);
    }
  }

  async stopAgent(name: string): Promise<void> {
    const managed = this.agents.get(name);
    if (!managed || !managed.session) {
      throw new ManagerError("NOT_RUNNING", `Agent ${name} is not running`);
    }

    // Stop health monitoring
    this.health.stop(name);

    // Unsubscribe from session events
    if (managed.unsubscribe) {
      managed.unsubscribe();
      managed.unsubscribe = null;
    }

    // Abort and dispose session
    await managed.session.abort();
    managed.session.dispose();
    managed.session = null;

    const fromStatus = managed.status;
    managed.status = "offline";
    managed.spawnedAt = null;

    // Trace
    const entry = this.trace.append({
      type: "agent_stopped",
      agent: name,
    } as any);
    this.subscriptions.match(entry);

    this.transitionState(name, fromStatus, "offline");
  }

  async restartAgent(name: string, prompt?: string): Promise<void> {
    const managed = this.agents.get(name);
    if (managed?.session) {
      await this.stopAgent(name);
    }

    this.trace.append({ type: "agent_restarted", agent: name, prompt } as any);
    await this.spawnAgent(name);

    if (prompt) {
      const agent = this.agents.get(name);
      if (agent?.session) {
        await agent.session.prompt(prompt);
      }
    }
  }

  async compactAgent(name: string): Promise<void> {
    const managed = this.agents.get(name);
    if (!managed?.session) {
      throw new ManagerError("NOT_RUNNING", `Agent ${name} is not running`);
    }
    await managed.session.compact();
    this.trace.append({ type: "agent_compacted", agent: name } as any);
  }

  // ─── Agent State ──────────────────────────────────────────────

  getAgentState(name: string): AgentState {
    const managed = this.agents.get(name);
    const config = this.settings.getAgentConfig(name);

    if (!managed && !config) {
      throw new ManagerError("NOT_FOUND", `Agent ${name} not found`);
    }

    const stats = this.router.getStats(name);
    const uptime = managed?.spawnedAt ? (Date.now() - managed.spawnedAt) / 1000 : 0;

    const ctx = managed?.session?.getContextUsage();
    const sessionStats = managed?.session?.getSessionStats();

    return {
      name,
      status: managed?.status ?? "offline",
      health: managed ? this.health.getHealth(name) : "healthy",
      contextPercent: ctx?.percent ?? 0,
      tokensUsed: sessionStats?.tokens.total ?? 0,
      cost: sessionStats?.cost ?? 0,
      messageStats: stats,
      uptime,
      lastActivity: new Date().toISOString(),
    };
  }

  listAgents(): AgentSummary[] {
    const configs = this.settings.getAllAgentConfigs();
    return configs.map((c) => {
      const managed = this.agents.get(c.name);
      const ctx = managed?.session?.getContextUsage();
      return {
        name: c.name,
        status: managed?.status ?? "offline",
        health: managed ? this.health.getHealth(c.name) : "healthy",
        contextPercent: ctx?.percent ?? 0,
      };
    });
  }

  getAgentConfig(name: string): AgentConfig | undefined {
    return this.settings.getAgentConfig(name);
  }

  /**
   * Peek at an agent's recent messages (for observability).
   */
  peekAgent(name: string, lines?: number): { output: string } {
    const managed = this.agents.get(name);
    if (!managed?.session) {
      throw new ManagerError("NOT_RUNNING", `Agent ${name} is not running`);
    }

    const limit = lines ?? 20;
    const messages = managed.session.messages.slice(-limit);
    const output = messages
      .map((m) => {
        if (m.role === "assistant" && m.content) {
          return `[assistant] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`;
        }
        if (m.role === "user" && m.content) {
          return `[user] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`;
        }
        return `[${m.role}] (message)`;
      })
      .join("\n");

    return { output: output.slice(-5000) }; // cap at 5KB
  }

  // ─── Messaging ────────────────────────────────────────────────

  async sendMessage(opts: SendMessageOpts): Promise<MessageResult> {
    const result = this.router.sendMessage(opts);

    // Handle delivery based on recipient state
    if (result.status === "queued") {
      await this.tryDeliverMessage(opts.to, result);
    }

    return result;
  }

  getMessages(opts: { agent?: string; threadId?: string; limit?: number; before?: string }): Message[] {
    return this.router.getMessages(opts);
  }

  getThreads(opts: { agent?: string }): ThreadSummary[] {
    return this.router.getThreads(opts);
  }

  // ─── Subscriptions ───────────────────────────────────────────

  subscribe(filter: EventFilter, maxEvents: number): string {
    return this.subscriptions.subscribe(filter, maxEvents);
  }

  unsubscribe(id: string): boolean {
    return this.subscriptions.unsubscribe(id);
  }

  getSubscriptions() {
    return this.subscriptions.getSubscriptions();
  }

  /**
   * Register a listener for subscription events (pushed to manager via socket).
   */
  onSubscriptionEvent(listener: (event: SubscriptionEvent) => void): () => void {
    return this.subscriptions.onEvent(listener);
  }

  // ─── Trace ────────────────────────────────────────────────────

  queryTrace(opts: TraceQueryOpts): TraceEntry[] {
    return this.trace.query(opts);
  }

  // ─── Configuration ───────────────────────────────────────────

  async reloadSettings(): Promise<void> {
    await this.settings.reloadSettings();
  }

  getSettings(): Settings {
    return this.settings.getSettings();
  }

  async updateAcl(acl: AclRule[]): Promise<void> {
    await this.settings.updateAcl(acl);
  }

  // ─── Shutdown ─────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    // Stop all agents
    for (const [name, managed] of this.agents) {
      if (managed.session) {
        try {
          await this.stopAgent(name);
        } catch {
          // Best effort
        }
      }
    }

    this.trace.append({ type: "service_stopped" } as any);

    this.health.dispose();
    this.cutoff.dispose();
    this.subscriptions.dispose();
    this.trace.dispose();
    this.settings.dispose();
  }

  get uptime(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  get agentCount(): number {
    return this.agents.size;
  }

  // ─── Agent Registration ────────────────────────────────────────

  /**
   * Register a new agent. Creates folder + config files, adds to settings.
   */
  async registerAgent(name: string, agentPath?: string): Promise<{ status: string; scaffolded: boolean }> {
    const resolvedPath = agentPath ?? path.join(this.projectRoot, ".pi", "agents", name);
    const absPath = path.isAbsolute(resolvedPath) ? resolvedPath : path.join(this.projectRoot, resolvedPath);

    // Create folder + files if needed
    let scaffolded = false;
    if (!fs.existsSync(absPath)) {
      fs.mkdirSync(absPath, { recursive: true });
      scaffolded = true;
    }

    const configPath = path.join(absPath, "agent.json");
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(
        configPath,
        `${JSON.stringify({ name, brief: "TODO: Describe what this agent does.", auto_spawn: false }, null, 2)}\n`,
      );
      scaffolded = true;
    }

    const systemPath = path.join(absPath, "SYSTEM.md");
    if (!fs.existsSync(systemPath)) {
      fs.writeFileSync(systemPath, `# Agent: ${name}\n\nTODO: Define this agent's role.\n`);
      scaffolded = true;
    }

    const agentsPath = path.join(absPath, "AGENTS.md");
    if (!fs.existsSync(agentsPath)) {
      fs.writeFileSync(agentsPath, "");
      scaffolded = true;
    }

    // Add to settings.agents if not already there
    const settings = this.settings.getSettings();
    const relPath = path.isAbsolute(resolvedPath) ? resolvedPath : resolvedPath;
    if (!settings.agents.includes(relPath)) {
      settings.agents.push(relPath);
      // Also add default ACL: manager↔agent
      const hasAcl = settings.acl.some((r) => r.from === name);
      if (!hasAcl) {
        settings.acl.push({ from: name, to: ["manager"] });
      }
      // Write updated settings and reload
      await this.settings.updateSettings({ agents: settings.agents, acl: settings.acl });
      await this.settings.reloadSettings();
    }

    return { status: "ok", scaffolded };
  }

  /**
   * Unregister an agent. Removes from settings but doesn't delete folder.
   */
  async unregisterAgent(name: string): Promise<void> {
    const settings = this.settings.getSettings();
    settings.agents = settings.agents.filter((_p) => {
      const config = this.settings.getAgentConfig(name);
      return config?.name !== name;
    });
    await this.settings.reloadSettings();
  }

  // ─── Internal: Extension Resolution ───────────────────────────

  /**
   * Resolve extension names to file paths.
   * Checks: ~/.pi/packagemanager/packages/{name}/extensions/
   */
  private resolveExtensionPaths(extensions: string[]): string[] {
    const paths: string[] = [];
    const pmDir = path.join(os.homedir(), ".pi", "packagemanager", "packages");

    for (const ext of extensions) {
      // Try direct name
      const extDir = path.join(pmDir, ext, "extensions");
      if (fs.existsSync(extDir)) {
        const files = fs.readdirSync(extDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
        for (const f of files) {
          paths.push(path.join(extDir, f));
        }
        continue;
      }

      // Try with pi-extension- prefix
      const prefixedDir = path.join(pmDir, `pi-extension-${ext}`, "extensions");
      if (fs.existsSync(prefixedDir)) {
        const files = fs.readdirSync(prefixedDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
        for (const f of files) {
          paths.push(path.join(prefixedDir, f));
        }
        continue;
      }

      // Try as absolute path
      if (path.isAbsolute(ext) && fs.existsSync(ext)) {
        paths.push(ext);
        continue;
      }

      console.warn(`Extension not found: ${ext}`);
    }

    return paths;
  }

  // ─── Internal: Session Event Handling ─────────────────────────

  private handleSessionEvent(agentName: string, event: any): void {
    const managed = this.agents.get(agentName);
    if (!managed) return;

    switch (event.type) {
      case "agent_start":
        this.transitionState(agentName, "online-idle", "online-working");
        this.health.start(agentName);
        break;

      case "agent_end": {
        this.transitionState(agentName, "online-working", "online-idle");
        this.health.stop(agentName);

        // Check cutoff
        const pct = managed.session?.getContextUsage()?.percent ?? 0;
        const warning = this.cutoff.checkOnAgentEnd(
          agentName,
          pct,
          managed.config.cutoff_polite_pct,
          managed.config.cutoff_hard_pct,
        );

        if (warning) {
          // Enqueue cutoff warning as a message
          this.router.sendMessage({
            from: "system",
            to: agentName,
            subject: `Context ${warning.level} warning`,
            body: warning.message,
            priority: warning.level === "hard" ? "important" : "normal",
          });
        }

        // Drain message queue
        this.drainAndDeliver(agentName);
        break;
      }

      case "tool_execution_end":
        if (this.cutoff.isHardSteering(agentName) && managed.session) {
          managed.session.steer(
            this.cutoff.getSteerMessage(agentName, managed.session?.getContextUsage()?.percent ?? 0),
          );
        }
        break;

      case "message_update":
        if (event.assistantMessageEvent?.type === "text_delta") {
          this.health.recordToken(agentName);
        }
        break;
    }
  }

  private transitionState(agentName: string, from: string, to: string): void {
    const managed = this.agents.get(agentName);
    if (managed) {
      managed.status = to as any;
    }

    const entry = this.trace.append({
      type: "agent_state",
      agent: agentName,
      from,
      to,
    } as any);
    this.subscriptions.match(entry);
  }

  private async tryDeliverMessage(agentName: string, _result: MessageResult): Promise<void> {
    const managed = this.agents.get(agentName);
    if (!managed?.session) return;

    if (managed.status === "online-idle") {
      // Deliver immediately
      const msg = this.router.drainQueue(agentName);
      if (msg) {
        this.router.markRead(agentName, 1);
        const formatted = this.formatMessageForAgent(msg);
        await managed.session.prompt(formatted);
      }
    }
    // If working + important → steer
    else if (managed.status === "online-working") {
      if (this.router.hasImportantMessages(agentName)) {
        const msg = this.router.drainImportant(agentName);
        if (msg) {
          this.router.markRead(agentName, 1);
          await managed.session.steer(`⚡ IMPORTANT message from ${msg.from}: ${msg.subject}\n\n${msg.body}`);
        }
      }
      // Normal messages wait for agent_end
    }
  }

  private async drainAndDeliver(agentName: string): Promise<void> {
    const managed = this.agents.get(agentName);
    if (!managed?.session) return;

    const msg = this.router.drainQueue(agentName);
    if (msg) {
      this.router.markRead(agentName, 1);
      const formatted = this.formatMessageForAgent(msg);
      await managed.session.prompt(formatted);
    }
  }

  private formatMessageForAgent(msg: Message): string {
    const priority = msg.priority === "important" ? "⚡ IMPORTANT " : "";
    return `${priority}📨 Message from **${msg.from}**\n**Subject:** ${msg.subject}\n**Thread:** ${msg.threadId}\n\n${msg.body}`;
  }

  private buildAgentMessageOverview(agentName: string, firstMsg?: Message): string {
    const stats = this.router.getStats(agentName);
    const threads = this.router.getThreads({ agent: agentName });

    const overview = buildMessageOverview({
      unreadCount: stats.unread,
      threads: threads.map((t) => ({
        subject: t.subject,
        with: t.participants.filter((p) => p !== agentName).join(", "),
        messageCount: t.messageCount,
        lastActivity: t.lastActivity,
      })),
    });

    if (firstMsg) {
      return `${overview}\n\n---\n\n${this.formatMessageForAgent(firstMsg)}`;
    }
    return overview;
  }

  private getPromptBuilderDeps(): PromptBuilderDeps {
    return {
      getAgentConfig: (n) => this.settings.getAgentConfig(n),
      getAllAgentConfigs: () => this.settings.getAllAgentConfigs(),
      getAcl: () => this.settings.getAcl(),
      resolveAgentPath: (p) => this.settings.resolveAgentPath(p),
      getAgentPaths: () => this.settings.getSettings().agents,
    };
  }

  private getToolCallbacks(_agentName: string): AgentToolCallbacks {
    return {
      onMessageSent: (_from, to, messageId, threadId) => {
        // Trigger delivery for recipient
        this.tryDeliverMessage(to, { messageId, threadId, status: "queued" });
      },
      onContextHandoff: async (name, summary, continueMessage) => {
        const managed = this.agents.get(name);
        if (!managed?.session) return;

        // Trace
        this.trace.append({
          type: "context_reset",
          agent: name,
          percent: managed.session?.getContextUsage()?.percent ?? 0,
          summary,
          continueMessage,
        } as any);

        // Reset cutoff
        this.cutoff.reset(name);

        // New session
        await managed.session.newSession();

        // Build overview and prompt
        const overview = this.buildAgentMessageOverview(name);
        const prompt = `${continueMessage}\n\n${overview}\n\n### Previous Session Handoff\n${summary}`;
        await managed.session.prompt(prompt);
      },
      getContextPercent: (n) => {
        const m = this.agents.get(n);
        return m?.session?.getContextUsage()?.percent ?? 0;
      },
      getTokensUsed: (n) => {
        const m = this.agents.get(n);
        return m?.session?.getSessionStats()?.tokens.total ?? 0;
      },
      getCost: (n) => {
        const m = this.agents.get(n);
        return m?.session?.getSessionStats()?.cost ?? 0;
      },
      getUptime: (name) => {
        const m = this.agents.get(name);
        return m?.spawnedAt ? (Date.now() - m.spawnedAt) / 1000 : 0;
      },
    };
  }
}

export class ManagerError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ManagerError";
  }
}
