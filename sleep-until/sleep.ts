import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text, visibleWidth } from "@mariozechner/pi-tui";

// ── Shared countdown widget ────────────────────────────────────────────

async function showCountdown(
  totalSeconds: number,
  ctx: ExtensionContext,
  label: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const widgetId = "sleep-countdown";
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

        const text = ` ⏱️ ${label}${label ? " " : ""}${timeStr} `;
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

// ── Until loop state ───────────────────────────────────────────────────

const HARD_LIMIT = 100;

interface UntilState {
  maxTurns: number;
  delay: number;
  currentTurn: number;
}

let untilState: UntilState | null = null;

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {

  // ── /sleep <seconds> [prompt] ──────────────────────────────────────

  pi.registerCommand("sleep", {
    description: "Sleep N seconds, optionally run a prompt after. Usage: /sleep 30 [prompt]",
    handler: async (args, ctx) => {
      const match = args?.trim().match(/^(\d+)\s*(.*)?$/);
      if (!match) {
        ctx.ui.notify("Usage: /sleep <seconds> [prompt]", "warning");
        return;
      }
      const seconds = parseInt(match[1], 10);
      const prompt = match[2]?.trim() || "";

      const completed = await showCountdown(seconds, ctx, "", undefined);
      if (!completed) {
        ctx.ui.notify("⏱️ Sleep cancelled", "warning");
        return;
      }

      if (prompt) {
        ctx.ui.notify(`⏱️ Slept ${seconds}s — running prompt`, "info");
        pi.sendUserMessage(prompt);
      } else {
        ctx.ui.notify(`⏱️ Slept for ${seconds}s`, "info");
      }
    },
  });

  // ── /until <description> ──────────────────────────────────────────

  pi.registerCommand("until", {
    description: "AI-driven loop: describe what to check and how. Usage: /until <natural language description>",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /until <describe what to do, how many turns, delay, condition>", "warning");
        return;
      }

      const description = args.trim();

      // Hidden message with full instructions for the AI
      pi.sendMessage({
        customType: "until-loop",
        content: [
          `## /until — Loop Instructions (hidden from user)`,
          ``,
          `The user wants you to run a repeating check/task:`,
          ``,
          `> ${description}`,
          ``,
          `### Step 1: Propose a plan (this turn)`,
          ``,
          `Parse the request and propose a SHORT plan:`,
          `- What you'll do, how many turns, delay between checks, stop condition`,
          ``,
          `Then ask: **"Should I start, or would you like to modify?"**`,
          ``,
          `### Step 2: After user confirms`,
          ``,
          `Use the \`until\` tool to run the loop:`,
          `1. Call \`until\` with action "start" to begin (set turns, delay)`,
          `2. Do your check/work`,
          `3. If condition is met → call \`until\` with action "resolve"`,
          `4. If NOT met → call \`until\` with action "next" (this sleeps and advances the turn)`,
          `5. Repeat from step 2`,
          ``,
          `**Do NOT start the loop until the user confirms.** Only propose the plan now.`,
        ].join("\n"),
        display: false,
      }, {
        deliverAs: "nextTurn",
      });

      // Visible user message — short and clean
      pi.sendUserMessage(`/until ${description}`);
    },
  });

  // ── sleep tool ────────────────────────────────────────────────────

  pi.registerTool({
    name: "sleep",
    label: "Sleep",
    description: "Sleep/wait for a specified number of seconds. Shows a full-width countdown progress bar to the user.",
    parameters: Type.Object({
      seconds: Type.Number({ description: "Number of seconds to sleep/wait" }),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { seconds } = params as { seconds: number };
      const totalSeconds = Math.max(1, Math.round(seconds));
      const completed = await showCountdown(totalSeconds, ctx, "", signal);

      return {
        content: [{
          type: "text" as const,
          text: completed
            ? `⏱️ Slept for ${totalSeconds} seconds.`
            : `⏱️ Sleep cancelled.`,
        }],
        details: { seconds: totalSeconds },
      };
    },

    renderCall(_args, theme) {
      return new Text("", 0, 0);
    },

    renderResult(result, _opts, theme) {
      const secs = result.details?.seconds;
      const msg = secs ? `⏱️ Slept for ${secs}s` : "⏱️ Done";
      return new Text(theme.fg("dim", msg), 0, 0);
    },
  });

  // ── until tool (unified: start / next / resolve) ──────────────────

  pi.registerTool({
    name: "until",
    label: "Until",
    description: [
      "Manage a repeating check/loop. Three actions:",
      "",
      '• action "start" — Begin a new loop. Set turns (max iterations, default 10, hard limit 100) and delay (seconds between checks, default 30). Returns confirmation.',
      '• action "next" — Advance to next turn. Sleeps for the configured delay with a countdown bar, then increments the turn counter. Returns current turn or stops if limit reached.',
      '• action "resolve" — End the loop because the condition is met. Provide a reason summarizing what was achieved.',
      "",
      "Typical flow: start → do work → next → do work → ... → resolve",
    ].join("\n"),
    promptGuidelines: [
      'Always call `until` with action "start" before using "next" or "resolve"',
      'Call "next" to sleep between checks — it tracks turns and enforces the hard limit of 100',
      'Call "resolve" as soon as the condition is met — do not continue looping unnecessarily',
      "If the condition can never be met, stop and explain to the user instead of looping to the limit",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("next"),
        Type.Literal("resolve"),
      ], { description: '"start" to begin, "next" to advance, "resolve" to end' }),
      turns: Type.Optional(Type.Number({ description: "Max iterations (action=start only, default 10, hard limit 100)" })),
      delay: Type.Optional(Type.Number({ description: "Seconds between checks (action=start only, default 30)" })),
      reason: Type.Optional(Type.String({ description: "Why the condition is met (action=resolve only)" })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { action, turns, delay, reason } = params as {
        action: "start" | "next" | "resolve";
        turns?: number;
        delay?: number;
        reason?: string;
      };

      if (action === "start") {
        const maxTurns = Math.min(HARD_LIMIT, Math.max(1, Math.round(turns ?? 10)));
        const delaySeconds = Math.max(1, Math.round(delay ?? 30));
        untilState = { maxTurns, delay: delaySeconds, currentTurn: 0 };

        return {
          content: [{
            type: "text" as const,
            text: `⏱️ Until loop started: ${maxTurns} turns, ${delaySeconds}s delay. Do your first check now.`,
          }],
          details: { action: "start", maxTurns, delay: delaySeconds },
        };
      }

      if (action === "next") {
        if (!untilState) {
          return {
            content: [{ type: "text" as const, text: "⚠️ No active until loop. Call with action \"start\" first." }],
            details: { action: "next", error: true },
          };
        }

        untilState.currentTurn++;
        const { currentTurn, maxTurns, delay: d } = untilState;

        if (currentTurn >= maxTurns) {
          const msg = `⏱️ Until loop exhausted: reached ${maxTurns}/${maxTurns} turns. Stopping.`;
          untilState = null;
          return {
            content: [{ type: "text" as const, text: msg }],
            details: { action: "next", turn: currentTurn, maxTurns, exhausted: true },
          };
        }

        const label = `turn ${currentTurn + 1}/${maxTurns}`;
        const completed = await showCountdown(d, ctx, label, signal);

        if (!completed) {
          untilState = null;
          return {
            content: [{ type: "text" as const, text: "⏱️ Until loop cancelled." }],
            details: { action: "next", cancelled: true },
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: `⏱️ Turn ${currentTurn + 1}/${maxTurns} — do your next check.`,
          }],
          details: { action: "next", turn: currentTurn + 1, maxTurns },
        };
      }

      if (action === "resolve") {
        const r = reason || "condition met";
        const turn = untilState?.currentTurn ?? 0;
        const max = untilState?.maxTurns ?? 0;
        untilState = null;

        return {
          content: [{ type: "text" as const, text: `✅ Until loop resolved: ${r}` }],
          details: { action: "resolve", reason: r, turn, maxTurns: max },
        };
      }

      return {
        content: [{ type: "text" as const, text: `⚠️ Unknown action: ${action}` }],
        details: { error: true },
      };
    },

    renderCall(args, theme) {
      const action = args?.action;
      if (action === "start") return new Text(theme.fg("accent", "⏱️ Starting loop"), 0, 0);
      if (action === "next") return new Text("", 0, 0);
      if (action === "resolve") return new Text(theme.fg("success", "⏱️ Condition met"), 0, 0);
      return new Text("", 0, 0);
    },

    renderResult(result, _opts, theme) {
      const d = result.details;
      if (!d) return new Text("", 0, 0);

      if (d.action === "start") {
        return new Text(theme.fg("dim", `⏱️ Loop: ${d.maxTurns} turns, ${d.delay}s delay`), 0, 0);
      }
      if (d.action === "next" && d.exhausted) {
        return new Text(theme.fg("warning", `⏱️ Loop exhausted at ${d.maxTurns} turns`), 0, 0);
      }
      if (d.action === "next") {
        return new Text(theme.fg("dim", `⏱️ Turn ${d.turn}/${d.maxTurns}`), 0, 0);
      }
      if (d.action === "resolve") {
        return new Text(theme.fg("dim", `⏱️ Resolved: ${d.reason}`), 0, 0);
      }
      return new Text("", 0, 0);
    },
  });
}
