/**
 * Manager Monitor — loop system for periodic agent oversight.
 *
 * State persists to monitor-state.json so it survives context resets.
 * Includes countdown widget between cycles.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, visibleWidth } from "@mariozechner/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

interface MonitorConfig {
  interval_seconds: number;
  max_turns: number;
}

interface MonitorState {
  currentTurn: number;
  running: boolean;
  startedAt: string;
}

const STATE_FILE = "monitor-state.json";

function loadState(managerDir: string): MonitorState {
  const path = join(managerDir, STATE_FILE);
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, "utf-8")); } catch { /* corrupted */ }
  }
  return { currentTurn: 0, running: false, startedAt: "" };
}

function saveState(managerDir: string, state: MonitorState) {
  try { writeFileSync(join(managerDir, STATE_FILE), JSON.stringify(state, null, 2)); } catch { /* ignore */ }
}

function loadMonitorInstructions(managerDir: string): string {
  const monitorPath = join(managerDir, "MONITOR.md");
  if (existsSync(monitorPath)) {
    try { return readFileSync(monitorPath, "utf-8").trim(); } catch { /* fall through */ }
  }
  return "Check messages, review project state, take action as needed.";
}

function loadFindings(managerDir: string): string {
  const findingsPath = join(managerDir, "FINDINGS.md");
  if (existsSync(findingsPath)) {
    try { return readFileSync(findingsPath, "utf-8").trim(); } catch { /* fall through */ }
  }
  return "No previous findings.";
}

async function showCountdown(
  totalSeconds: number,
  ctx: ExtensionContext,
  label: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const widgetId = "monitor-countdown";
  let remaining = totalSeconds;

  const renderWidget = () => {
    ctx.ui.setWidget(widgetId, (_tui, theme) => ({
      render(width: number): string[] {
        const fraction = remaining / totalSeconds;
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        const timeStr = mins > 0
          ? `${mins}m ${secs.toString().padStart(2, "0")}s`
          : `${secs}s`;

        const text = ` ⏱️ ${label} ${timeStr} `;
        const textWidth = visibleWidth(text);
        const barSpace = Math.max(0, width - textWidth);
        const filled = Math.round(fraction * barSpace);
        const empty = barSpace - filled;

        return [theme.fg("accent", text) + theme.fg("accent", "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty))];
      },
      invalidate() {},
    }), { placement: "aboveEditor" });
  };

  renderWidget();

  for (let i = totalSeconds - 1; i >= 0; i--) {
    if (signal?.aborted) {
      ctx.ui.setWidget(widgetId, undefined);
      return false;
    }
    await new Promise((r) => setTimeout(r, 1000));
    remaining = i;
    renderWidget();
  }

  ctx.ui.setWidget(widgetId, undefined);
  return true;
}

export function registerMonitor(pi: ExtensionAPI, managerDir: string, config: MonitorConfig) {
  // ── Monitor loop tool ─────────────────────────────────────────────

  pi.registerTool({
    name: "manager_monitor",
    label: "Monitor",
    description: [
      "Manage the monitor loop. Three actions:",
      "",
      '• action "start" — Begin monitoring. Resets turn counter and starts the cycle.',
      '• action "next" — Sleep for the configured interval, then inject the next cycle prompt.',
      '• action "stop" — Stop the monitor loop. Clears the turn counter.',
      "",
      `Configured: ${config.interval_seconds}s interval, ${config.max_turns} max turns.`,
      "State persists across context resets via monitor-state.json.",
    ].join("\n"),
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("next"),
        Type.Literal("stop"),
      ], { description: '"start" to begin, "next" to advance, "stop" to end' }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { action } = params as { action: "start" | "next" | "stop" };

      if (action === "start") {
        const state: MonitorState = { currentTurn: 0, running: true, startedAt: new Date().toISOString() };
        saveState(managerDir, state);

        const instructions = loadMonitorInstructions(managerDir);
        const findings = loadFindings(managerDir);

        return {
          content: [{
            type: "text" as const,
            text: `🔄 Monitor started (${config.max_turns} turns, ${config.interval_seconds}s interval)\n\n## Instructions\n${instructions}\n\n## Previous Findings\n${findings}`,
          }],
        };
      }

      if (action === "next") {
        const state = loadState(managerDir);
        if (!state.running) {
          return { content: [{ type: "text" as const, text: "⚠️ Monitor not running. Use action \"start\" first." }], isError: true };
        }

        state.currentTurn++;
        if (state.currentTurn >= config.max_turns) {
          state.running = false;
          state.currentTurn = 0;
          saveState(managerDir, state);
          return { content: [{ type: "text" as const, text: `🛑 Monitor exhausted: reached ${config.max_turns} turns. Loop stopped and counter reset.` }] };
        }

        saveState(managerDir, state);

        const label = `Monitor ${state.currentTurn + 1}/${config.max_turns}`;
        const completed = await showCountdown(config.interval_seconds, ctx, label, signal);

        if (!completed) {
          state.running = false;
          state.currentTurn = 0;
          saveState(managerDir, state);
          return { content: [{ type: "text" as const, text: "🛑 Monitor cancelled. Counter reset." }] };
        }

        const instructions = loadMonitorInstructions(managerDir);
        const findings = loadFindings(managerDir);

        return {
          content: [{
            type: "text" as const,
            text: `🔄 Monitor cycle ${state.currentTurn + 1}/${config.max_turns}\n\n## Instructions\n${instructions}\n\n## Current Findings\n${findings}`,
          }],
        };
      }

      if (action === "stop") {
        const state: MonitorState = { currentTurn: 0, running: false, startedAt: "" };
        saveState(managerDir, state);
        return { content: [{ type: "text" as const, text: "⏹️ Monitor stopped. Counter reset." }] };
      }

      return { content: [{ type: "text" as const, text: `⚠️ Unknown action: ${action}` }], isError: true };
    },

    renderCall(args, theme) {
      const action = (args as any)?.action;
      if (action === "start") return new Text(theme.fg("accent", "🔄 Starting monitor"), 0, 0);
      if (action === "next") return new Text("", 0, 0);
      if (action === "stop") return new Text(theme.fg("warning", "⏹️ Stopping monitor"), 0, 0);
      return new Text("", 0, 0);
    },

    renderResult(result, _opts, theme) {
      const text = result.content?.[0]?.text || "";
      if (text.includes("Monitor started")) return new Text(theme.fg("dim", "🔄 Monitor active"), 0, 0);
      if (text.includes("cycle")) {
        const match = text.match(/cycle (\d+\/\d+)/);
        return new Text(theme.fg("dim", `🔄 ${match?.[1] || "cycle"}`), 0, 0);
      }
      if (text.includes("stopped") || text.includes("cancelled")) return new Text(theme.fg("dim", "⏹️ Monitor stopped"), 0, 0);
      return new Text(theme.fg("dim", text.slice(0, 50)), 0, 0);
    },
  });

  // Inject monitor knowledge into system prompt
  pi.on("before_agent_start", async (event) => {
    const state = loadState(managerDir);
    const statusLine = state.running
      ? `Monitor is **active** — turn ${state.currentTurn + 1}/${config.max_turns}, started at ${state.startedAt}`
      : "Monitor is **inactive**. Use `manager_monitor` with action \"start\" to begin.";

    const notice = `

## Monitor Loop

You have a \`manager_monitor\` tool for periodic oversight cycles:
- **start** — begins the monitor loop, shows MONITOR.md instructions + FINDINGS.md
- **next** — sleeps ${config.interval_seconds}s with countdown, then shows next cycle instructions
- **stop** — stops the loop and resets counter

Your findings file is at: ${managerDir}/FINDINGS.md — update it each cycle.
Your monitor instructions are at: ${managerDir}/MONITOR.md (fixed, don't edit).

**Status:** ${statusLine}
`;
    return { systemPrompt: (event.systemPrompt || "") + notice };
  });
}
