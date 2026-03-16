/**
 * Relay — writes JSON status to /tmp/pi-relay-<id>.json for manager monitoring.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeFileSync } from "fs";

export interface RelayStatus {
  pid: number;
  agent: string;
  timestamp: string;
  state: "working" | "idle" | "blocked" | "shutdown";
  blockReason?: string;
  tokenPct?: number;
  lastTool?: string;
  lastToolParams?: Record<string, unknown>;
  turnCount: number;
}

export function registerRelay(pi: ExtensionAPI, agentName: string, relayId: string) {
  const statusFile = `/tmp/pi-relay-${relayId}.json`;
  let turnCount = 0;
  let lastTool: string | undefined;

  function writeStatus(state: RelayStatus["state"], extra?: Partial<RelayStatus>) {
    const status: RelayStatus = {
      pid: process.pid,
      agent: agentName,
      timestamp: new Date().toISOString(),
      state,
      lastTool,
      turnCount,
      ...extra,
    };
    try {
      writeFileSync(statusFile, JSON.stringify(status) + "\n");
    } catch { /* ignore */ }
  }

  pi.on("agent_start", async (_event, ctx) => {
    const tokenPct = ctx?.getContextUsage?.()?.percent ?? undefined;
    writeStatus("working", { tokenPct });
  });

  pi.on("agent_end", async (_event, ctx) => {
    turnCount++;
    const tokenPct = ctx?.getContextUsage?.()?.percent ?? undefined;
    writeStatus("idle", { tokenPct });
  });

  pi.on("tool_call", async (event, ctx) => {
    lastTool = event.toolName;
    const tokenPct = ctx?.getContextUsage?.()?.percent ?? undefined;

    if (event.toolName === "questionnaire") {
      const questions = (event.input as any)?.questions;
      const questionText = Array.isArray(questions)
        ? questions.map((q: any) => q.prompt || q.id).join("; ")
        : "user input needed";
      writeStatus("blocked", { blockReason: `questionnaire: ${questionText}`, tokenPct });
    } else {
      writeStatus("working", { lastToolParams: summarizeParams(event.input), tokenPct });
    }
  });

  pi.on("tool_result", async (event) => {
    const text = event.content
      ?.filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(" ") || "";

    if (text.includes("Human validation required") || text.includes("Human Validation Required")) {
      writeStatus("blocked", { blockReason: `human validation: ${lastTool}` });
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      writeFileSync(statusFile, JSON.stringify({
        pid: process.pid, agent: agentName, state: "shutdown",
        timestamp: new Date().toISOString(), turnCount,
      }) + "\n");
    } catch { /* ignore */ }
  });

  writeStatus("idle");

  // Return getter so other modules can access turn count
  return { getTurnCount: () => turnCount };
}

function summarizeParams(input: any): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 100) {
      summary[key] = value.slice(0, 100) + "...";
    } else {
      summary[key] = value;
    }
  }
  return summary;
}
