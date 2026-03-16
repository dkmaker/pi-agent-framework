/**
 * Agent Service — manages SDK agent sessions, communicates via Unix socket.
 *
 * Listens for commands from the manager extension.
 * Pushes events (agent messages, status updates, tailing) back.
 */

import { createServer, type Socket } from "net";
import { unlinkSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import {
  AuthStorage, createAgentSession, ModelRegistry, SessionManager,
  SettingsManager, DefaultResourceLoader, type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { tmpdir } from "os";
import {
  SOCKET_PATH, encode, createLineParser,
  type Command, type ServiceEvent, type AgentStatus,
} from "./protocol.js";

// --- State ---
const agents = new Map<string, {
  session: AgentSession;
  status: AgentStatus;
  tailing: boolean;
}>();

const auth = AuthStorage.create();
const modelRegistry = new ModelRegistry(auth);
const emptyAgentDir = join(tmpdir(), `pi-agent-service-${process.pid}`);
mkdirSync(emptyAgentDir, { recursive: true });

// Message log for persistence
const MESSAGE_LOG = join(import.meta.dirname, "messages.log");

let clientSocket: Socket | null = null;

function sendEvent(event: ServiceEvent) {
  if (clientSocket && !clientSocket.destroyed) {
    clientSocket.write(encode(event));
  }
}

// --- Message routing ---
function routeMessage(from: string, to: string, content: string) {
  const timestamp = Date.now();

  // Persist to log
  appendFileSync(MESSAGE_LOG, JSON.stringify({ from, to, content, timestamp }) + "\n");

  // If target is "manager", push to the client socket
  if (to === "manager") {
    sendEvent({ type: "agent_message", from, to, content, timestamp });
    return;
  }

  // If target is another agent, inject as a prompt
  const target = agents.get(to);
  if (target) {
    console.log(`  📨 Routing message: ${from} → ${to}`);
    const msg = `**Message from ${from}:**\n${content}`;
    if (target.session.isStreaming) {
      // Agent is busy — queue for after current turn
      target.session.followUp(msg);
    } else {
      // Agent is idle — prompt directly
      target.session.prompt(msg).catch((err) => {
        console.error(`  ❌ Error prompting ${to}:`, err.message);
      });
    }
  } else {
    console.log(`  ⚠️ Agent "${to}" not found, message from "${from}" dropped`);
  }
}

// --- Create agent tools ---
function makeAgentTools(agentName: string, knownAgents: string[]): ToolDefinition[] {
  return [
    {
      name: "send_message",
      label: "Send Message",
      description: `Send a message to another agent or to the manager. Available targets: ${["manager", ...knownAgents].join(", ")}`,
      parameters: Type.Object({
        to: Type.String({ description: "Recipient name (another agent name or 'manager')" }),
        message: Type.String({ description: "Message content" }),
      }),
      execute: async (_id, params) => {
        routeMessage(agentName, params.to, params.message);
        return {
          content: [{ type: "text" as const, text: `Message sent to ${params.to}` }],
          details: {},
        };
      },
    },
  ];
}

// --- Spawn agent ---
async function spawnAgent(name: string, systemPrompt: string, extensions?: string[]) {
  if (agents.has(name)) {
    sendEvent({ type: "command_response", command: "spawn_agent", success: false, error: `Agent "${name}" already exists` });
    return;
  }

  console.log(`🚀 Spawning agent: ${name}`);

  const model = getModel("anthropic", "claude-haiku-3-5-20241022");
  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const projectRoot = process.cwd();

  const loaderOpts: any = {
    cwd: projectRoot,
    agentDir: emptyAgentDir,
    settingsManager: settings,
    systemPromptOverride: () => systemPrompt,
  };
  if (extensions?.length) {
    loaderOpts.additionalExtensionPaths = extensions;
  }

  const loader = new DefaultResourceLoader(loaderOpts);
  await loader.reload();

  // Get all known agent names for the send_message tool
  const knownAgents = [...agents.keys(), name];

  const { session } = await createAgentSession({
    cwd: projectRoot,
    agentDir: emptyAgentDir,
    model,
    thinkingLevel: "off",
    authStorage: auth,
    modelRegistry,
    tools: [],
    customTools: makeAgentTools(name, knownAgents),
    sessionManager: SessionManager.inMemory(),
    settingsManager: settings,
    resourceLoader: loader,
  });

  const status: AgentStatus = {
    isStreaming: false,
    contextPercent: 0,
    tokenUsage: { input: 0, output: 0, total: 0 },
    cost: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    lastActivity: Date.now(),
  };

  const agentEntry = { session, status, tailing: false };
  agents.set(name, agentEntry);

  // Subscribe to events for status tracking + tailing
  session.subscribe((event: any) => {
    status.lastActivity = Date.now();

    if (event.type === "agent_start") {
      status.isStreaming = true;
    }

    if (event.type === "agent_end") {
      status.isStreaming = false;
      // Update stats
      const stats = session.getSessionStats() as any;
      const ctx = session.getContextUsage() as any;
      status.contextPercent = ctx.percent;
      status.tokenUsage = { input: stats.tokens.input, output: stats.tokens.output, total: stats.tokens.total };
      status.cost = stats.cost;
      status.userMessages = stats.userMessages;
      status.assistantMessages = stats.assistantMessages;
      status.toolCalls = stats.toolCalls;
    }

    if (event.type === "tool_execution_start") {
      status.toolCalls++;
      console.log(`  🔧 ${name}: ${event.toolName}`);
    }

    // Tailing — stream text deltas to manager
    if (agentEntry.tailing && event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      sendEvent({ type: "agent_tail", name, delta: event.assistantMessageEvent.delta });
    }
  });

  sendEvent({ type: "agent_spawned", name });
  console.log(`✅ Agent "${name}" ready`);
}

// --- Handle commands ---
async function handleCommand(cmd: Command) {
  try {
    switch (cmd.type) {
      case "spawn_agent":
        await spawnAgent(cmd.name, cmd.systemPrompt, cmd.extensions);
        break;

      case "stop_agent": {
        const agent = agents.get(cmd.name);
        if (agent) {
          agent.session.dispose();
          agents.delete(cmd.name);
          sendEvent({ type: "agent_stopped", name: cmd.name });
          console.log(`🛑 Agent "${cmd.name}" stopped`);
        }
        break;
      }

      case "send_message":
        routeMessage(cmd.from, cmd.to, cmd.content);
        sendEvent({ type: "command_response", command: "send_message", success: true });
        break;

      case "get_status": {
        const allStatus: Record<string, AgentStatus> = {};
        for (const [name, agent] of agents) {
          allStatus[name] = agent.status;
        }
        sendEvent({ type: "all_status", agents: allStatus });
        break;
      }

      case "get_agent_status": {
        const agent = agents.get(cmd.name);
        if (agent) {
          sendEvent({ type: "agent_status", name: cmd.name, status: agent.status });
        }
        break;
      }

      case "tail_agent": {
        const agent = agents.get(cmd.name);
        if (agent) {
          agent.tailing = cmd.enabled;
          console.log(`${cmd.enabled ? "👁️" : "🔇"} Tailing ${cmd.enabled ? "enabled" : "disabled"} for "${cmd.name}"`);
        }
        break;
      }
    }
  } catch (err: any) {
    console.error(`❌ Error handling command:`, err);
    sendEvent({ type: "command_response", command: cmd.type, success: false, error: err.message });
  }
}

// --- Start server ---
if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

const server = createServer((socket) => {
  console.log("🔌 Manager connected");
  clientSocket = socket;
  sendEvent({ type: "service_ready" });

  const parse = createLineParser((line) => {
    try {
      const cmd = JSON.parse(line) as Command;
      handleCommand(cmd);
    } catch (err) {
      console.error("Failed to parse command:", line);
    }
  });

  socket.on("data", (chunk) => parse(chunk.toString()));
  socket.on("close", () => {
    console.log("🔌 Manager disconnected");
    clientSocket = null;
  });
  socket.on("error", (err) => {
    console.error("Socket error:", err.message);
    clientSocket = null;
  });
});

server.listen(SOCKET_PATH, () => {
  console.log(`🟢 Agent Service listening on ${SOCKET_PATH}`);
  console.log("Waiting for manager connection...\n");
});

// Cleanup
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down...");
  for (const [name, agent] of agents) {
    agent.session.dispose();
    console.log(`  Disposed: ${name}`);
  }
  server.close();
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  process.exit(0);
});
