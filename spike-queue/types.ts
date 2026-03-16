/**
 * Core types for the agent service — transport-agnostic.
 */

// === Agent States ===
export type AgentState = "offline" | "online-idle" | "online-working";

// === Messages ===
export interface Message {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  priority: "normal" | "important";
  delivery: "persist" | "online-only";
  replyTo?: string;
  timestamp: number;
  status: "queued" | "delivered" | "read" | "failed";
  deliveredAt?: number;
  readAt?: number;
}

// === Threads ===
export interface Thread {
  id: string;
  subject: string;
  participants: string[];
  messageCount: number;
  createdAt: number;
  lastActivity: number;
}

export const MAX_THREAD_MESSAGES = 100;

// === Agent Status ===
export interface AgentStatus {
  name: string;
  state: AgentState;
  contextPercent: number;
  tokenUsage: { input: number; output: number; total: number };
  cost: number;
  messageStats: { sent: number; received: number; queued: number };
  uptime: number;
  lastActivity: number;
  health: "healthy" | "slow" | "stuck" | "error";
}

// === State Transitions ===
export interface StateTransition {
  agent: string;
  from: AgentState;
  to: AgentState;
  timestamp: number;
  reason: string;
}

// === Trace Entries ===
export type TraceEntry =
  | { type: "message"; message: Message }
  | { type: "state_change"; transition: StateTransition }
  | { type: "agent_spawn"; name: string; timestamp: number }
  | { type: "agent_stop"; name: string; reason: string; timestamp: number }
  | { type: "delivery"; messageId: string; status: "delivered" | "read" | "failed"; timestamp: number }
  | { type: "thread_created"; threadId: string; participants: string[]; timestamp: number }
  | { type: "thread_exhausted"; threadId: string; count: number; timestamp: number }
  | { type: "service_start"; timestamp: number }
  | { type: "error"; agent?: string; error: string; timestamp: number };

// === Service Events (pushed to clients) ===
export type ServiceEvent =
  | { type: "service_ready" }
  | { type: "agent_spawned"; name: string }
  | { type: "agent_stopped"; name: string; reason: string }
  | { type: "agent_state_change"; name: string; state: AgentState; reason: string }
  | { type: "agent_message"; message: Message }
  | { type: "all_status"; agents: Record<string, AgentStatus> }
  | { type: "agent_status"; status: AgentStatus }
  | { type: "agent_tail"; name: string; delta: string }
  | { type: "command_ok"; command: string; data?: any }
  | { type: "command_error"; command: string; error: string }
  | { type: "queue_flush"; messages: Message[] };
