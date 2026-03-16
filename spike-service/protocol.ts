/**
 * Shared protocol types for Unix socket communication.
 * JSON lines over Unix socket — one JSON object per line.
 */

// === Manager → Service (Commands) ===

export type Command =
  | { type: "spawn_agent"; name: string; systemPrompt: string; extensions?: string[] }
  | { type: "stop_agent"; name: string }
  | { type: "send_message"; from: string; to: string; content: string }
  | { type: "get_status" }
  | { type: "get_agent_status"; name: string }
  | { type: "tail_agent"; name: string; enabled: boolean };

// === Service → Manager (Events) ===

export type ServiceEvent =
  | { type: "agent_spawned"; name: string }
  | { type: "agent_stopped"; name: string }
  | { type: "agent_error"; name: string; error: string }
  | { type: "agent_message"; from: string; to: string; content: string; timestamp: number }
  | { type: "agent_status"; name: string; status: AgentStatus }
  | { type: "all_status"; agents: Record<string, AgentStatus> }
  | { type: "agent_tail"; name: string; delta: string }
  | { type: "command_response"; command: string; success: boolean; error?: string }
  | { type: "service_ready" };

export interface AgentStatus {
  isStreaming: boolean;
  contextPercent: number;
  tokenUsage: { input: number; output: number; total: number };
  cost: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  lastActivity: number;
}

// === Socket path ===

export const SOCKET_PATH = "/tmp/pi-agent-service.sock";

// === JSONL helpers ===

export function encode(obj: Command | ServiceEvent): string {
  return JSON.stringify(obj) + "\n";
}

export function createLineParser(onLine: (line: string) => void) {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) onLine(line);
    }
  };
}
