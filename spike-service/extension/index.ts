/**
 * Manager Extension — connects to the Agent Service via Unix socket.
 * Registers tools for spawning agents, sending messages, checking status.
 * Receives events from the service and injects agent messages into the conversation.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { connect, type Socket } from "net";
import { SOCKET_PATH, encode, createLineParser, type ServiceEvent, type Command } from "../protocol.js";

export default function (pi: ExtensionAPI) {
  let socket: Socket | null = null;
  let connected = false;
  const pendingMessages: Array<{ from: string; content: string }> = [];

  // --- Connect to service ---
  function connectToService() {
    socket = connect(SOCKET_PATH);

    const parse = createLineParser((line) => {
      try {
        const event = JSON.parse(line) as ServiceEvent;
        handleEvent(event);
      } catch (err) {
        console.error("Failed to parse event:", line);
      }
    });

    socket.on("connect", () => {
      connected = true;
      console.log("[agents] Connected to agent service");
    });

    socket.on("data", (chunk) => parse(chunk.toString()));

    socket.on("close", () => {
      connected = false;
      console.log("[agents] Disconnected from agent service");
      // Retry after 3s
      setTimeout(connectToService, 3000);
    });

    socket.on("error", (err: any) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        console.log("[agents] Service not running, retrying in 3s...");
        setTimeout(connectToService, 3000);
      }
    });
  }

  function send(cmd: Command) {
    if (socket && connected) {
      socket.write(encode(cmd));
    } else {
      console.log("[agents] Not connected to service");
    }
  }

  // --- Handle events from service ---
  function handleEvent(event: ServiceEvent) {
    switch (event.type) {
      case "service_ready":
        console.log("[agents] Service ready");
        break;

      case "agent_spawned":
        console.log(`[agents] Agent "${event.name}" spawned`);
        break;

      case "agent_stopped":
        console.log(`[agents] Agent "${event.name}" stopped`);
        break;

      case "agent_message":
        // Queue message — will be injected into conversation
        pendingMessages.push({ from: event.from, content: event.content });
        // Inject into manager's conversation
        pi.sendUserMessage(
          `📨 **Message from agent "${event.from}":**\n\n${event.content}`
        );
        break;

      case "agent_error":
        pi.sendUserMessage(
          `⚠️ **Agent "${event.name}" error:** ${event.error}`
        );
        break;

      case "all_status":
        // Handled by tool response, stored temporarily
        lastStatusResponse = event;
        break;

      case "agent_status":
        lastAgentStatusResponse = event;
        break;

      case "agent_tail":
        // Could render in a widget, for now just log
        process.stdout.write(event.delta);
        break;
    }
  }

  // Temp storage for async tool responses from service
  let lastStatusResponse: ServiceEvent | null = null;
  let lastAgentStatusResponse: ServiceEvent | null = null;

  // Helper to wait for a specific event type
  function waitForEvent(type: string, timeout = 30000): Promise<ServiceEvent> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = setInterval(() => {
        if (type === "all_status" && lastStatusResponse) {
          clearInterval(check);
          const r = lastStatusResponse;
          lastStatusResponse = null;
          resolve(r);
        } else if (type === "agent_status" && lastAgentStatusResponse) {
          clearInterval(check);
          const r = lastAgentStatusResponse;
          lastAgentStatusResponse = null;
          resolve(r);
        } else if (Date.now() - start > timeout) {
          clearInterval(check);
          reject(new Error(`Timeout waiting for ${type}`));
        }
      }, 100);
    });
  }

  // --- Register tools ---
  pi.on("session_start", () => {
    connectToService();
  });

  pi.on("session_shutdown", () => {
    if (socket) socket.destroy();
  });

  pi.registerTool({
    name: "agent_spawn",
    label: "Spawn Agent",
    description: "Spawn a new agent with a given name and system prompt",
    parameters: Type.Object({
      name: Type.String({ description: "Agent name (unique identifier)" }),
      systemPrompt: Type.String({ description: "System prompt defining the agent's role and behavior" }),
    }),
    async execute(_id, params) {
      send({ type: "spawn_agent", name: params.name, systemPrompt: params.systemPrompt });
      // Wait a moment for the spawned event
      await new Promise((r) => setTimeout(r, 2000));
      return {
        content: [{ type: "text", text: `Agent "${params.name}" spawn requested. It should be ready shortly.` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "agent_message",
    label: "Send Message to Agent",
    description: "Send a message to a running agent",
    parameters: Type.Object({
      to: Type.String({ description: "Target agent name" }),
      message: Type.String({ description: "Message content" }),
    }),
    async execute(_id, params) {
      send({ type: "send_message", from: "manager", to: params.to, content: params.message });
      return {
        content: [{ type: "text", text: `Message sent to "${params.to}"` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "agent_status",
    label: "Get Agent Status",
    description: "Get status of all running agents (context %, tokens, cost, streaming state)",
    parameters: Type.Object({}),
    async execute() {
      send({ type: "get_status" });
      try {
        const response = await waitForEvent("all_status", 5000) as any;
        const lines: string[] = ["# Agent Status\n"];
        for (const [name, status] of Object.entries(response.agents) as any) {
          lines.push(`## ${name}`);
          lines.push(`- Streaming: ${status.isStreaming ? "🟢 yes" : "⚪ idle"}`);
          lines.push(`- Context: ${status.contextPercent.toFixed(1)}%`);
          lines.push(`- Tokens: ${status.tokenUsage.total} (in: ${status.tokenUsage.input}, out: ${status.tokenUsage.output})`);
          lines.push(`- Cost: $${status.cost.toFixed(4)}`);
          lines.push(`- Messages: ${status.userMessages} user, ${status.assistantMessages} assistant`);
          lines.push(`- Tool calls: ${status.toolCalls}`);
          lines.push(`- Last activity: ${new Date(status.lastActivity).toISOString()}\n`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
      } catch {
        return { content: [{ type: "text", text: "Timeout waiting for status response" }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: "agent_stop",
    label: "Stop Agent",
    description: "Stop a running agent",
    parameters: Type.Object({
      name: Type.String({ description: "Agent name to stop" }),
    }),
    async execute(_id, params) {
      send({ type: "stop_agent", name: params.name });
      return {
        content: [{ type: "text", text: `Stop requested for "${params.name}"` }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "agent_tail",
    label: "Tail Agent Output",
    description: "Enable or disable real-time output tailing for an agent",
    parameters: Type.Object({
      name: Type.String({ description: "Agent name" }),
      enabled: Type.Boolean({ description: "true to start tailing, false to stop" }),
    }),
    async execute(_id, params) {
      send({ type: "tail_agent", name: params.name, enabled: params.enabled });
      return {
        content: [{ type: "text", text: `Tailing ${params.enabled ? "enabled" : "disabled"} for "${params.name}"` }],
        details: {},
      };
    },
  });
}
