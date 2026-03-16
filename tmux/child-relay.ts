/**
 * Child Relay Extension
 *
 * Lightweight extension injected into child pi sessions via `-e` flag.
 * Writes a JSON status file that the parent session watches for live feedback.
 *
 * Reads PI_RELAY_ID env var to determine status file path:
 *   /tmp/pi-relay-<PI_RELAY_ID>.json
 *
 * This file is self-contained — no imports from developer-mode.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeFileSync } from "fs";

interface RelayStatus {
  pid: number;
  timestamp: string;
  state: "working" | "idle" | "blocked";
  blockReason?: string;
  tokenPct?: number;
  lastTool?: string;
  lastToolParams?: Record<string, unknown>;
  turnCount: number;
}

export default function (pi: ExtensionAPI) {
  const relayId = process.env.PI_RELAY_ID;
  if (!relayId) return; // not a managed child session, skip

  const statusFile = `/tmp/pi-relay-${relayId}.json`;
  let turnCount = 0;
  let lastTool: string | undefined;

  function writeStatus(state: RelayStatus["state"], extra?: Partial<RelayStatus>) {
    const status: RelayStatus = {
      pid: process.pid,
      timestamp: new Date().toISOString(),
      state,
      lastTool,
      turnCount,
      ...extra,
    };
    try {
      writeFileSync(statusFile, JSON.stringify(status) + "\n");
    } catch {
      // ignore write errors
    }
  }

  // Agent turn started — we're working
  pi.on("agent_start", async (_event, ctx) => {
    const usage = ctx?.getContextUsage?.();
    const tokenPct = usage?.percent ?? undefined;
    writeStatus("working", { tokenPct });
  });

  // Agent turn ended — we're idle
  pi.on("agent_end", async (_event, ctx) => {
    turnCount++;
    const usage = ctx?.getContextUsage?.();
    const tokenPct = usage?.percent ?? undefined;
    writeStatus("idle", { tokenPct });
  });

  // Tool call — update last tool, detect blocking tools
  pi.on("tool_call", async (event, ctx) => {
    lastTool = event.toolName;
    const usage = ctx?.getContextUsage?.();
    const tokenPct = usage?.percent ?? undefined;

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

  // Tool result — check for human validation blockers
  pi.on("tool_result", async (event) => {
    const text = event.content
      ?.filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(" ") || "";

    if (text.includes("Human validation required") || text.includes("Human Validation Required")) {
      writeStatus("blocked", { blockReason: `human validation: ${lastTool}` });
    }
  });

  // Session shutdown — clean up
  pi.on("session_shutdown", async () => {
    try {
      writeFileSync(statusFile, JSON.stringify({ pid: process.pid, state: "shutdown", timestamp: new Date().toISOString() }) + "\n");
    } catch { /* ignore */ }
  });

  // Write initial status
  writeStatus("idle");
}

/** Summarize tool params to avoid writing huge JSON */
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
