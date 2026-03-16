/**
 * StateRecovery — rebuild service state from trace.jsonl on startup.
 *
 * On startup, if trace.jsonl exists:
 * 1. Scan all entries
 * 2. Rebuild message queues (queued without delivered)
 * 3. Rebuild thread metadata
 * 4. Do NOT re-spawn agents — they start offline
 * 5. Trace service_recovered entry
 *
 * Recovery is best-effort. Lost messages acceptable on crash.
 *
 * Reference: asset [f5z68c4v]
 */

import type { MessageRouter } from "./router.js";
import type { TraceWriter } from "./trace.js";
import type { TraceEntry } from "./types.js";

export interface RecoveryResult {
  recoveredAgents: string[];
  pendingMessages: number;
}

/**
 * Recover state from trace entries.
 * Called during AgentManager.create() if trace.jsonl exists.
 */
export function recoverFromTrace(entries: TraceEntry[], router: MessageRouter, trace: TraceWriter): RecoveryResult {
  // Restore router state (queues + threads)
  router.restoreFromTrace(entries);

  // Collect known agents
  const agents = new Set<string>();
  for (const e of entries) {
    const agent = (e as any).agent;
    if (agent) agents.add(agent);
  }

  // Count pending messages
  const delivered = new Set<string>();
  let pending = 0;

  for (const e of entries) {
    if (e.type === "message_status" && (e as any).status === "delivered") {
      delivered.add((e as any).messageId);
    }
  }
  for (const e of entries) {
    if (e.type === "message" && (e as any).status === "queued" && !delivered.has((e as any).messageId)) {
      pending++;
    }
  }

  const result: RecoveryResult = {
    recoveredAgents: Array.from(agents),
    pendingMessages: pending,
  };

  // Trace recovery
  trace.append({
    type: "service_recovered",
    recoveredAgents: result.recoveredAgents,
    pendingMessages: result.pendingMessages,
  } as any);

  return result;
}
