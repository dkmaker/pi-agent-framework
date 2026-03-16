/**
 * dev_tmux watch/unwatch tools + event emission for turn-end callbacks.
 *
 * When a watched tmux session transitions from working → idle,
 * fires pi.events.emit("tmux:turn_end", event) so the parent agent
 * can react without polling.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { TmuxWatcher, type TmuxTurnEndEvent, type RelayStatus } from "../tmux-watcher";
import { TmuxManager } from "../tmux-manager";
import { truncateToolResponse } from "../truncate-response";

export function registerDevTmuxWatchTools(
  pi: ExtensionAPI,
  manager: TmuxManager,
  watcher: TmuxWatcher
): void {
  const { Type } = require("@sinclair/typebox");

  // Capture latest ctx for status bar updates from timer callbacks
  let latestCtx: any = null;
  pi.on("before_agent_start", async (_event, ctx) => { latestCtx = ctx; });

  // Default callback: emit event + send message to parent agent
  function onTurnEnd(event: TmuxTurnEndEvent) {
    // Emit on the shared event bus
    pi.events.emit("tmux:turn_end", event);

    const statusLine = event.alive
      ? `Turn #${event.turnCount} completed in session ${event.sessionId}`
      : `Session ${event.sessionId} ended after ${event.turnCount} turn(s)`;

    const capture = truncateToolResponse(event.capture, {
      maxChars: 5000,
      toolName: "tmux-watch",
    });

    // 1. Hidden full capture for the AI (not shown to user)
    pi.sendMessage(
      {
        customType: "tmux-turn-end",
        content: `## 🖥️ Tmux Session Update\n\n**${statusLine}**\n\n\`\`\`\n${capture}\n\`\`\``,
        display: false,
      },
    );

    // 2. Trigger the agent turn with a clean status line
    // sendUserMessage is the only reliable way to trigger a turn from timer callbacks.
    // It's visible to the user — unavoidable, so make it the nice message.
    pi.sendUserMessage(`🖥️ ${statusLine}`, { deliverAs: "followUp" });


  }

  // ── Relay status callback ──────────────────────────────────────────

  let lastBlockedState = new Map<string, boolean>();

  function onRelayStatus(sessionId: string, status: RelayStatus) {
    // Build status bar text
    const parts: string[] = [];
    if (status.tokenPct != null) parts.push(`${status.tokenPct.toFixed(1)}%`);
    if (status.lastTool) parts.push(status.lastTool);

    const stateIcon = status.state === "blocked" ? "⚠️ BLOCKED"
      : status.state === "working" ? "⚡ working"
      : status.state === "idle" ? "💤 idle"
      : "🔌 " + status.state;
    parts.unshift(stateIcon);

    if (status.blockReason) parts.push(status.blockReason);

    if (latestCtx?.ui?.setStatus) {
      latestCtx.ui.setStatus(`child-${sessionId}`, `[child ${sessionId.slice(0, 6)}] ${parts.join(" │ ")}`);
    }

    // Alert on blocked state transitions
    const wasBlocked = lastBlockedState.get(sessionId) || false;
    if (status.state === "blocked" && !wasBlocked) {
      pi.sendMessage({
        customType: "tmux-relay-alert",
        content: `## ⚠️ Child Session Blocked\n\n**Session:** ${sessionId}\n**Reason:** ${status.blockReason || "unknown"}\n**Last tool:** ${status.lastTool || "n/a"}\n\nThe child session needs attention.`,
        display: true,
      });
      pi.sendUserMessage(`⚠️ Child session ${sessionId.slice(0, 6)} is BLOCKED: ${status.blockReason || "needs input"}`, { deliverAs: "followUp" });
    }
    lastBlockedState.set(sessionId, status.state === "blocked");
  }

  // ── pi_dev_tmux_watch ────────────────────────────────────────────

  pi.registerTool({
    name: "pi_dev_tmux_watch",
    label: "Watch tmux session",
    description:
      "Start watching a managed tmux session for turn-end events. " +
      "When the child pi completes a turn (working → idle), a message " +
      "is injected into this session with a pane capture. One-directional only (child → parent).",
    parameters: Type.Object({
      id: Type.String({ description: "Session ID to watch" }),
    }),
    async execute(_toolCallId: string, params: { id: string }) {
      try {
        // Verify session exists
        manager.capture(params.id);
        watcher.watch(params.id, onTurnEnd, onRelayStatus);
        return {
          content: [{
            type: "text",
            text: `Watching session ${params.id} for turn-end events. You'll receive pane captures when the child agent completes each turn.`,
          }],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Failed to watch: ${e.message}` }],
          isError: true,
        };
      }
    },
  });

  // ── pi_dev_tmux_unwatch ──────────────────────────────────────────

  pi.registerTool({
    name: "pi_dev_tmux_unwatch",
    label: "Unwatch tmux session",
    description: "Stop watching a managed tmux session for turn-end events.",
    parameters: Type.Object({
      id: Type.String({ description: "Session ID to stop watching" }),
    }),
    async execute(_toolCallId: string, params: { id: string }) {
      watcher.unwatch(params.id);
      lastBlockedState.delete(params.id);
      if (latestCtx?.ui?.setStatus) {
        latestCtx.ui.setStatus(`child-${params.id}`, undefined);
      }
      return {
        content: [{ type: "text", text: `Stopped watching session ${params.id}.` }],
      };
    },
  });
}
