/**
 * Agent tools factory — builds the 5 customTools registered per agent session.
 *
 * Tools: send_message, context_handoff, list_messages, list_threads, check_status
 *
 * Reference: asset [0l0qkut7]
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { MessageRouter } from "./router.js";
import type { TraceWriter } from "./trace.js";

/**
 * Callbacks the AgentManager provides to the tools.
 * Keeps tools decoupled from the manager.
 */
export interface AgentToolCallbacks {
  /** Called when agent sends a message */
  onMessageSent: (from: string, to: string, messageId: string, threadId: string) => void;
  /** Called when agent requests context handoff */
  onContextHandoff: (agentName: string, summary: string, continueMessage: string) => Promise<void>;
  /** Get context usage for an agent */
  getContextPercent: (agentName: string) => number;
  /** Get tokens used */
  getTokensUsed: (agentName: string) => number;
  /** Get cost */
  getCost: (agentName: string) => number;
  /** Get uptime */
  getUptime: (agentName: string) => number;
}

/**
 * Build the 5 agent tools for a specific agent.
 */
export function buildAgentTools(
  agentName: string,
  router: MessageRouter,
  trace: TraceWriter,
  callbacks: AgentToolCallbacks,
): ToolDefinition[] {
  return [
    buildSendMessageTool(agentName, router, callbacks),
    buildContextHandoffTool(agentName, callbacks),
    buildListMessagesTool(agentName, router),
    buildListThreadsTool(agentName, router),
    buildCheckStatusTool(agentName, callbacks),
  ];
}

function buildSendMessageTool(
  agentName: string,
  router: MessageRouter,
  callbacks: AgentToolCallbacks,
): ToolDefinition {
  return {
    name: "send_message",
    label: "Send Message",
    description: "Send a message to another agent or the manager.",
    parameters: Type.Object({
      to: Type.String({ description: 'Recipient agent name or "manager"' }),
      subject: Type.String({ description: "Short topic (5-10 words)" }),
      message: Type.String({ description: "Body content (markdown)" }),
      important: Type.Optional(Type.Boolean({ description: "Priority flag, interrupts recipient (default: false)" })),
      thread_id: Type.Optional(Type.String({ description: "Continue existing thread (omit for new)" })),
    }),
    execute: async (_toolCallId: string, params: any) => {
      try {
        const result = router.sendMessage({
          from: agentName,
          to: params.to,
          subject: params.subject,
          body: params.message,
          priority: params.important ? "important" : "normal",
          threadId: params.thread_id,
        });

        callbacks.onMessageSent(agentName, params.to, result.messageId, result.threadId);

        const count = router.getThreads({ agent: agentName })
          .find((t) => t.threadId === result.threadId)?.messageCount ?? 1;

        return {
          content: [{ type: "text" as const, text: `Sent to ${params.to} | Thread: ${result.threadId} (#${count})` }],
          details: { messageId: result.messageId, threadId: result.threadId, status: result.status },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to send: ${err.message}` }],
          details: { error: err.code ?? "UNKNOWN" },
        };
      }
    },
  };
}

function buildContextHandoffTool(
  agentName: string,
  callbacks: AgentToolCallbacks,
): ToolDefinition {
  return {
    name: "context_handoff",
    label: "Context Handoff",
    description: "Save state for context reset. Call when context is running low.",
    parameters: Type.Object({
      summary: Type.String({ description: "What you were doing, key findings, current state" }),
      continueMessage: Type.String({ description: "Exact prompt for your next session to continue" }),
    }),
    execute: async (_toolCallId: string, params: any) => {
      await callbacks.onContextHandoff(agentName, params.summary, params.continueMessage);
      return {
        content: [{ type: "text" as const, text: "Handoff recorded. Session will reset." }],
        details: {},
      };
    },
  };
}

function buildListMessagesTool(
  agentName: string,
  router: MessageRouter,
): ToolDefinition {
  return {
    name: "list_messages",
    label: "List Messages",
    description: "Query your sent/received message history.",
    parameters: Type.Object({
      thread_id: Type.Optional(Type.String({ description: "Filter by thread" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
    }),
    execute: async (_toolCallId: string, params: any) => {
      const messages = router.getMessages({
        agent: agentName,
        threadId: params.thread_id,
        limit: params.limit ?? 10,
      });

      if (messages.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No messages found." }],
          details: {},
        };
      }

      const lines = messages.map((m) => {
        const dir = m.from === agentName ? `→ ${m.to}` : `← ${m.from}`;
        const preview = m.body.length > 100 ? m.body.slice(0, 100) + "..." : m.body;
        return `[${m.timestamp}] ${dir} | ${m.subject}\n  ${preview}`;
      });

      return {
        content: [{ type: "text" as const, text: lines.join("\n\n") }],
        details: { count: messages.length },
      };
    },
  };
}

function buildListThreadsTool(
  agentName: string,
  router: MessageRouter,
): ToolDefinition {
  return {
    name: "list_threads",
    label: "List Threads",
    description: "See your active conversation threads.",
    parameters: Type.Object({}),
    execute: async (_toolCallId: string, _params: any) => {
      const threads = router.getThreads({ agent: agentName });

      if (threads.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No active threads." }],
          details: {},
        };
      }

      const lines = threads.map((t) =>
        `- "${t.subject}" with ${t.participants.filter((p) => p !== agentName).join(", ")} (${t.messageCount} msgs, last: ${t.lastActivity})`,
      );

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { count: threads.length },
      };
    },
  };
}

function buildCheckStatusTool(
  agentName: string,
  callbacks: AgentToolCallbacks,
): ToolDefinition {
  return {
    name: "check_status",
    label: "Check Status",
    description: "Check your own resource usage.",
    parameters: Type.Object({}),
    execute: async (_toolCallId: string, _params: any) => {
      const pct = callbacks.getContextPercent(agentName);
      const tokens = callbacks.getTokensUsed(agentName);
      const cost = callbacks.getCost(agentName);
      const uptime = callbacks.getUptime(agentName);

      const uptimeStr = uptime > 3600
        ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
        : `${Math.floor(uptime / 60)}m`;

      return {
        content: [{
          type: "text",
          text: `Context: ${pct}% | Tokens: ${tokens.toLocaleString()} | Cost: $${cost.toFixed(4)} | Uptime: ${uptimeStr}`,
        }],
        details: { contextPercent: pct, tokensUsed: tokens, cost, uptime },
      };
    },
  };
}
