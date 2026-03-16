/**
 * AgentManager — manages agent sessions with state machine, queue delivery, and health monitoring.
 * Transport-agnostic core API.
 */

import {
  AuthStorage, createAgentSession, ModelRegistry, SessionManager,
  SettingsManager, DefaultResourceLoader, type AgentSession, type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentState, AgentStatus, StateTransition, ServiceEvent } from "./types.js";
import { MessageQueue } from "./message-queue.js";
import { Trace } from "./trace.js";

interface AgentEntry {
  name: string;
  session: AgentSession;
  state: AgentState;
  spawnedAt: number;
  lastActivity: number;
  lastTokenTime: number;
  turnStartTime: number;
  tailing: boolean;
}

export class AgentManager {
  private agents = new Map<string, AgentEntry>();
  private auth: AuthStorage;
  private modelRegistry: ModelRegistry;
  private emptyAgentDir: string;
  private listeners: Array<(event: ServiceEvent) => void> = [];
  private deliveryInterval: ReturnType<typeof setInterval> | null = null;

  queue: MessageQueue;
  trace: Trace;

  constructor(private traceFile: string) {
    this.auth = AuthStorage.create();
    this.modelRegistry = new ModelRegistry(this.auth);
    this.emptyAgentDir = join(tmpdir(), `pi-agent-svc-${process.pid}`);
    mkdirSync(this.emptyAgentDir, { recursive: true });

    this.trace = new Trace(traceFile);
    this.queue = new MessageQueue(this.trace);
    this.trace.append({ type: "service_start", timestamp: Date.now() });

    // Start delivery loop — check queues every 500ms
    this.deliveryInterval = setInterval(() => this.processQueues(), 500);
  }

  /** Subscribe to service events */
  subscribe(listener: (event: ServiceEvent) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }

  private emit(event: ServiceEvent) {
    for (const l of this.listeners) {
      try { l(event); } catch {}
    }
  }

  private setState(agent: AgentEntry, newState: AgentState, reason: string) {
    const transition: StateTransition = {
      agent: agent.name,
      from: agent.state,
      to: newState,
      timestamp: Date.now(),
      reason,
    };
    agent.state = newState;
    this.trace.append({ type: "state_change", transition });
    this.emit({ type: "agent_state_change", name: agent.name, state: newState, reason });
  }

  /** Spawn an agent */
  async spawnAgent(name: string, systemPrompt: string, extensions?: string[]) {
    if (this.agents.has(name)) {
      throw new Error(`Agent "${name}" already exists`);
    }

    const model = getModel("anthropic", "claude-haiku-3-5-20241022");
    const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
    const projectRoot = process.cwd();

    const loaderOpts: any = {
      cwd: projectRoot,
      agentDir: this.emptyAgentDir,
      settingsManager: settings,
      systemPromptOverride: () => systemPrompt,
    };
    if (extensions?.length) loaderOpts.additionalExtensionPaths = extensions;

    const loader = new DefaultResourceLoader(loaderOpts);
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: projectRoot,
      agentDir: this.emptyAgentDir,
      model,
      thinkingLevel: "off",
      authStorage: this.auth,
      modelRegistry: this.modelRegistry,
      tools: [],
      customTools: this.makeAgentTools(name),
      sessionManager: SessionManager.inMemory(),
      settingsManager: settings,
      resourceLoader: loader,
    });

    const entry: AgentEntry = {
      name,
      session,
      state: "online-idle",
      spawnedAt: Date.now(),
      lastActivity: Date.now(),
      lastTokenTime: 0,
      turnStartTime: 0,
      tailing: false,
    };

    this.agents.set(name, entry);

    session.subscribe((event: any) => {
      entry.lastActivity = Date.now();

      if (event.type === "agent_start") {
        this.setState(entry, "online-working", "prompt_delivered");
        entry.turnStartTime = Date.now();
      }

      if (event.type === "agent_end") {
        this.setState(entry, "online-idle", "turn_complete");
      }

      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        entry.lastTokenTime = Date.now();
        if (entry.tailing) {
          this.emit({ type: "agent_tail", name, delta: event.assistantMessageEvent.delta });
        }
      }

      if (event.type === "tool_execution_start") {
        this.trace.append({
          type: "error", // reuse for tool_call logging (or add new type)
          agent: name,
          error: `tool_call: ${event.toolName}`,
          timestamp: Date.now(),
        });
      }
    });

    this.trace.append({ type: "agent_spawn", name, timestamp: Date.now() });
    this.emit({ type: "agent_spawned", name });
  }

  /** Stop an agent */
  stopAgent(name: string, reason = "manual") {
    const entry = this.agents.get(name);
    if (!entry) throw new Error(`Agent "${name}" not found`);
    entry.session.dispose();
    this.setState(entry, "offline", reason);
    this.agents.delete(name);
    this.trace.append({ type: "agent_stop", name, reason, timestamp: Date.now() });
    this.emit({ type: "agent_stopped", name, reason });
  }

  /** Send a message through the queue */
  sendMessage(from: string, to: string, subject: string, body: string, opts?: {
    priority?: "normal" | "important";
    delivery?: "persist" | "online-only";
    threadId?: string;
    replyTo?: string;
  }) {
    const agentState = this.getAgentState(to);
    const result = this.queue.send({
      from, to, subject, body,
      priority: opts?.priority,
      delivery: opts?.delivery,
      threadId: opts?.threadId,
      replyTo: opts?.replyTo,
      agentState,
    });

    if (typeof result === "string") {
      return { error: result };
    }

    // If target is manager, emit immediately
    if (to === "manager") {
      this.emit({ type: "agent_message", message: result });
    }

    return { message: result };
  }

  /** Process message queues — deliver to idle agents */
  private processQueues() {
    for (const [name, entry] of this.agents) {
      if (entry.state !== "online-idle") continue;

      const message = this.queue.peek(name);
      if (!message) continue;

      // Deliver
      const delivered = this.queue.deliver(name);
      if (!delivered) continue;

      const formatted = `📨 **Message from ${delivered.from}**\n**Subject:** ${delivered.subject}\n**Thread:** ${delivered.threadId}\n\n${delivered.body}\n\n---\n*Reply with send_message to "${delivered.from}", thread_id: "${delivered.threadId}"*`;

      if (delivered.priority === "important" && entry.session.isStreaming) {
        entry.session.steer(formatted);
      } else {
        entry.session.prompt(formatted).catch((err) => {
          this.trace.append({ type: "error", agent: name, error: err.message, timestamp: Date.now() });
        });
      }
    }

    // Also flush manager queue if someone is listening
    const managerQueued = this.queue.queueDepth("manager");
    if (managerQueued > 0) {
      const messages = this.queue.flushQueue("manager");
      if (messages.length > 0) {
        this.emit({ type: "queue_flush", messages });
      }
    }
  }

  /** Get agent state */
  private getAgentState(name: string): AgentState {
    if (name === "manager") return "online-idle"; // manager is always "online" conceptually
    return this.agents.get(name)?.state || "offline";
  }

  /** Get status for all agents */
  getAllStatus(): Record<string, AgentStatus> {
    const result: Record<string, AgentStatus> = {};
    for (const [name, entry] of this.agents) {
      result[name] = this.getStatus(entry);
    }
    return result;
  }

  /** Get status for one agent */
  getAgentStatus(name: string): AgentStatus | undefined {
    const entry = this.agents.get(name);
    return entry ? this.getStatus(entry) : undefined;
  }

  private getStatus(entry: AgentEntry): AgentStatus {
    const stats = entry.session.getSessionStats() as any;
    const ctx = entry.session.getContextUsage() as any;
    const msgStats = this.queue.getStats(entry.name);

    // Health detection
    let health: "healthy" | "slow" | "stuck" | "error" = "healthy";
    if (entry.state === "online-working") {
      const elapsed = Date.now() - entry.turnStartTime;
      const tokenGap = entry.lastTokenTime > 0 ? Date.now() - entry.lastTokenTime : 0;
      if (tokenGap > 30000) health = "stuck";
      else if (elapsed > 60000) health = "slow";
    }

    return {
      name: entry.name,
      state: entry.state,
      contextPercent: ctx.percent,
      tokenUsage: { input: stats.tokens.input, output: stats.tokens.output, total: stats.tokens.total },
      cost: stats.cost,
      messageStats: msgStats,
      uptime: Date.now() - entry.spawnedAt,
      lastActivity: entry.lastActivity,
      health,
    };
  }

  /** Set tailing for an agent */
  setTailing(name: string, enabled: boolean) {
    const entry = this.agents.get(name);
    if (entry) entry.tailing = enabled;
  }

  /** Get agent names */
  getAgentNames(): string[] {
    return [...this.agents.keys()];
  }

  /** Clean shutdown */
  dispose() {
    if (this.deliveryInterval) clearInterval(this.deliveryInterval);
    for (const [name, entry] of this.agents) {
      entry.session.dispose();
    }
    this.agents.clear();
  }

  /** Create agent tools — the send_message tool agents use */
  private makeAgentTools(agentName: string): ToolDefinition[] {
    return [
      {
        name: "send_message",
        label: "Send Message",
        description: "Send a message to another agent or to the manager.",
        parameters: Type.Object({
          to: Type.String({ description: "Recipient (agent name or 'manager')" }),
          subject: Type.String({ description: "Short topic (5-10 words)" }),
          message: Type.String({ description: "Message content (markdown)" }),
          important: Type.Optional(Type.Boolean({ description: "Urgent — interrupts recipient. Default: false" })),
          thread_id: Type.Optional(Type.String({ description: "Thread ID to continue. Omit for new thread." })),
        }),
        execute: async (_id, params: any) => {
          const result = this.sendMessage(agentName, params.to, params.subject, params.message, {
            priority: params.important ? "important" : "normal",
            threadId: params.thread_id,
          });

          if ("error" in result) {
            return { content: [{ type: "text" as const, text: `❌ ${result.error}` }], details: {} };
          }

          const msg = result.message!;
          const threadCount = this.queue.getThread(msg.threadId)?.messageCount || 0;
          return {
            content: [{ type: "text" as const, text: `📤 Sent to ${params.to} | Thread: ${msg.threadId} (#${threadCount})` }],
            details: {},
          };
        },
      },
    ];
  }
}
