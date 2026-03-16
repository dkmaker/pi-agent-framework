/**
 * Core types for the pi-agent-service.
 *
 * References:
 * - Agent Service API: asset [i5eisc9o]
 * - Settings & Config: asset [n2j36dl7]
 * - State Machine & Health: asset [ik1yp2tc]
 * - Trace Log: asset [f5z68c4v]
 * - Event Subscriptions: asset [il2m3sl0]
 * - Unix Socket Protocol: asset [4o3g4qf3]
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";

// ─── Agent State Machine ────────────────────────────────────────────

export type AgentStatus = "offline" | "online-idle" | "online-working";
export type AgentHealth = "healthy" | "slow" | "stuck";

export interface ManagedAgent {
  name: string;
  config: AgentConfig;
  session: AgentSession | null; // null when offline
  status: AgentStatus;
  health: AgentHealth;
  queue: Message[]; // pending delivery
  hardSteering: boolean; // context cutoff active
  politeWarned: boolean; // polite cutoff sent
  lastTokenTime: number; // for health detection
  spawnedAt: number | null;
  unsubscribe: (() => void) | null; // session event unsub
}

// ─── Settings & Configuration ───────────────────────────────────────

export interface Settings {
  defaults: AgentDefaults;
  service: ServiceConfig;
  monitor: MonitorConfig;
  acl: AclRule[];
  agents: string[]; // paths to agent folders
}

export interface AgentDefaults {
  provider: string;
  model: string;
  thinking: string;
  cutoff_polite_pct: number;
  cutoff_hard_pct: number;
}

export interface ServiceConfig {
  socket_path: string;
  pid_file: string;
  trace_file: string;
  log_level: string;
}

export interface MonitorConfig {
  interval_seconds: number;
  max_turns: number;
  instructions_file: string;
}

export interface AclRule {
  from: string;
  to: string[];
}

export interface AgentConfig {
  name: string;
  brief: string;
  provider: string;
  model: string;
  thinking: string;
  cutoff_polite_pct: number;
  cutoff_hard_pct: number;
  extensions: string[];
  coding_tools: boolean;
  auto_spawn: boolean;
}

// ─── Messaging ──────────────────────────────────────────────────────

export interface Message {
  messageId: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  priority: "normal" | "important";
  delivery: "persist" | "online-only";
  replyTo?: string;
  timestamp: string; // ISO 8601
  status: "queued" | "delivered" | "dropped";
}

export interface MessageResult {
  messageId: string;
  threadId: string;
  status: "queued" | "delivered" | "dropped";
}

export interface ThreadSummary {
  threadId: string;
  participants: string[];
  messageCount: number;
  lastActivity: string; // ISO 8601
  subject: string;
}

// ─── Trace Log ──────────────────────────────────────────────────────

export type TraceEntryType =
  | "message"
  | "message_status"
  | "agent_state"
  | "agent_health"
  | "agent_spawned"
  | "agent_stopped"
  | "agent_restarted"
  | "agent_compacted"
  | "context_warning"
  | "context_reset"
  | "service_started"
  | "service_stopped"
  | "service_recovered";

export interface TraceEntry {
  id: string;
  ts: string; // ISO 8601
  type: TraceEntryType;
  [key: string]: unknown;
}

// ─── Subscriptions (Manager-Only) ───────────────────────────────────

export interface EventFilter {
  types?: TraceEntryType[];
  agent?: string;
  threadId?: string;
}

export interface Subscription {
  id: string;
  filter: EventFilter;
  maxEvents: number;
  deliveredCount: number;
  status: "active" | "expired" | "cancelled";
}

// ─── Agent State (query response) ───────────────────────────────────

export interface AgentState {
  name: string;
  status: AgentStatus;
  health: AgentHealth;
  contextPercent: number;
  tokensUsed: number;
  cost: number;
  messageStats: {
    sent: number;
    received: number;
    unread: number;
  };
  uptime: number;
  lastActivity: string;
}

export interface AgentSummary {
  name: string;
  status: AgentStatus;
  health: AgentHealth;
  contextPercent: number;
}

// ─── Protocol (Unix Socket) ─────────────────────────────────────────

export interface ProtocolRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface ProtocolResponse {
  id: string;
  result?: unknown;
  error?: ProtocolError;
}

export interface ProtocolEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface ProtocolError {
  code: ProtocolErrorCode;
  message: string;
}

export type ProtocolErrorCode =
  | "NOT_FOUND"
  | "ALREADY_RUNNING"
  | "NOT_RUNNING"
  | "ACL_DENIED"
  | "THREAD_LIMIT"
  | "INVALID_PARAMS"
  | "INTERNAL";

// ─── Default Values ─────────────────────────────────────────────────

export const DEFAULT_SETTINGS: Settings = {
  defaults: {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    thinking: "off",
    cutoff_polite_pct: 70,
    cutoff_hard_pct: 90,
  },
  service: {
    socket_path: "/tmp/pi-agent-service.sock",
    pid_file: "/tmp/pi-agent-service.pid",
    trace_file: ".pi/agents/trace.jsonl",
    log_level: "info",
  },
  monitor: {
    interval_seconds: 300,
    max_turns: 10,
    instructions_file: ".pi/agents/LOOP_INSTRUCTIONS.md",
  },
  acl: [],
  agents: [],
};

export const DEFAULT_AGENT_CONFIG: Omit<AgentConfig, "name"> = {
  brief: "TODO: Describe what this agent does in 1-2 sentences.",
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  thinking: "off",
  cutoff_polite_pct: 70,
  cutoff_hard_pct: 90,
  extensions: [],
  coding_tools: true,
  auto_spawn: false,
};
