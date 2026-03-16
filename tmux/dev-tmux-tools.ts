/**
 * dev_tmux_* tools — managed tmux session tools.
 *
 * spawn, send, inject, capture, attach, close, list
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "child_process";
import * as path from "path";
import { TmuxManager } from "../tmux-manager";
import { truncateToolResponse } from "../truncate-response";

// Resolve relay extension path once at load time (absolute)
const RELAY_EXT_PATH = path.resolve(__dirname, "..", "child-relay.ts");

// ─── Self-tmux helpers (when pi is running inside tmux) ──────────

function getSelfTmux(): { socket: string; pane: string } | null {
  const tmuxEnv = process.env.TMUX;
  if (!tmuxEnv) return null;
  const [socket] = tmuxEnv.split(",");
  const pane = process.env.TMUX_PANE || "";
  return { socket, pane };
}

function captureSelfTmux(lines?: number): string | null {
  const self = getSelfTmux();
  if (!self) return null;
  const startArg = lines ? `-S -${lines}` : "";
  const paneArg = self.pane ? `-t '${self.pane}'` : "";
  return execSync(
    `tmux -S '${self.socket}' capture-pane ${paneArg} -p ${startArg}`,
    { encoding: "utf-8" }
  ).trimEnd();
}

function sendToSelfTmux(keys: string): boolean {
  const self = getSelfTmux();
  if (!self) return false;
  const paneArg = self.pane ? `-t '${self.pane}'` : "";
  execSync(`tmux -S '${self.socket}' send-keys ${paneArg} ${keys}`, { stdio: "ignore" });
  return true;
}

function injectToSelfTmux(content: string, submit: boolean = false): boolean {
  const self = getSelfTmux();
  if (!self) return false;
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tmpFile = path.join(os.tmpdir(), `pi-dev-self-inject-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmpFile, content, "utf-8");
    execSync(`tmux -S '${self.socket}' load-buffer '${tmpFile}'`, { stdio: "ignore" });
    const paneArg = self.pane ? `-t '${self.pane}'` : "";
    execSync(`tmux -S '${self.socket}' paste-buffer ${paneArg}`, { stdio: "ignore" });
    if (submit) {
      execSync(`tmux -S '${self.socket}' send-keys ${paneArg} Enter`, { stdio: "ignore" });
    }
    return true;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

export function registerDevTmuxTools(pi: ExtensionAPI, manager: TmuxManager): void {
  const { Type } = require("@sinclair/typebox");

  function updateStatus(ctx: any) {
    const alive = manager.list().filter((s) => s.alive).length;
    if (!ctx?.ui?.setStatus) return;
    ctx.ui.setStatus("tmux-sessions", alive > 0 ? `🖥️ ${alive} tmux` : "");
  }

  // ── dev_tmux_spawn ─────────────────────────────────────────────────

  pi.registerTool({
    name: "pi_dev_tmux_spawn",
    label: "Spawn tmux session",
    description:
      "Create a managed tmux session with pi-optimized config (extended-keys, csi-u). " +
      "Optionally run an initial command. Returns session ID for use with other dev_tmux_* tools.",
    parameters: Type.Object({
      command: Type.Optional(Type.String({ description: "Command to run in the session (default: $SHELL)" })),
      name: Type.Optional(Type.String({ description: "Session name (default: auto-generated)" })),
      relay: Type.Optional(Type.Boolean({ description: "Inject relay extension for live status feedback (default: false). Use when spawning a child pi session you plan to watch." })),
    }),
    async execute(_id: string, params: { command?: string; name?: string; relay?: boolean }, _signal: any, _onUpdate: any, ctx: any) {
      try {
        const session = manager.spawn({
          ...params,
          relayExtPath: params.relay ? RELAY_EXT_PATH : undefined,
        });
        updateStatus(ctx);
        return {
          content: [
            {
              type: "text",
              text: [
                `Session spawned:`,
                `  id: ${session.id}`,
                `  name: ${session.sessionName}`,
                `  socket: ${session.socket}`,
                session.command ? `  command: ${session.command}` : `  command: (default shell)`,
              ].join("\n"),
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed to spawn tmux session: ${e.message}` }], isError: true };
      }
    },
  });

  // ── dev_tmux_send ──────────────────────────────────────────────────

  pi.registerTool({
    name: "pi_dev_tmux_send",
    label: "Send keys to tmux",
    description:
      "Send keystrokes/commands to a managed tmux session. For short single-line input. " +
      "Use dev_tmux_inject for multi-line content.",
    parameters: Type.Object({
      id: Type.String({ description: "Session ID" }),
      keys: Type.String({ description: "Keystrokes to send (tmux send-keys format, e.g. 'ls -la' or 'Enter')" }),
    }),
    async execute(_id: string, params: { id: string; keys: string }) {
      try {
        manager.send(params.id, params.keys);
        return { content: [{ type: "text", text: `Sent keys to session ${params.id}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
      }
    },
  });

  // ── dev_tmux_inject ────────────────────────────────────────────────

  pi.registerTool({
    name: "pi_dev_tmux_inject",
    label: "Inject content into tmux",
    description:
      "Inject multi-line content into a managed tmux session via tmux load-buffer + paste-buffer. " +
      "For structured plans, long prompts, review instructions. Optionally sends Enter to submit.",
    parameters: Type.Object({
      id: Type.String({ description: "Session ID" }),
      content: Type.String({ description: "Multi-line content to inject" }),
      submit: Type.Optional(Type.Boolean({ description: "Send Enter after pasting to submit (default: false)" })),
    }),
    async execute(_id: string, params: { id: string; content: string; submit?: boolean }) {
      try {
        manager.inject(params.id, params.content, params.submit);
        const lines = params.content.split("\n").length;
        return {
          content: [
            {
              type: "text",
              text: `Injected ${lines} line(s) into session ${params.id}${params.submit ? " (submitted)" : ""}`,
            },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
      }
    },
  });

  // ── dev_tmux_capture ───────────────────────────────────────────────

  pi.registerTool({
    name: "pi_dev_tmux_capture",
    label: "Capture tmux pane",
    description:
      "Capture the current pane content from a managed tmux session. Returns visible text. " +
      "If no id is provided and pi is running inside tmux, captures the current session automatically.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Session ID (omit to capture current tmux session if pi is running in tmux)" })),
      lines: Type.Optional(Type.Number({ description: "Number of lines to capture from scrollback (default: visible pane)" })),
      file: Type.Optional(Type.String({ description: "File path to save the capture to (in addition to returning inline)" })),
    }),
    async execute(_id: string, params: { id?: string; lines?: number; file?: string }) {
      try {
        let output: string;
        if (params.id) {
          output = manager.capture(params.id, params.lines);
        } else {
          const selfCapture = captureSelfTmux(params.lines);
          if (selfCapture === null) {
            return { content: [{ type: "text", text: "No session id provided and pi is not running inside tmux." }], isError: true };
          }
          output = selfCapture;
        }
        const text = output || "(empty pane)";
        if (params.file) {
          const fs = require("fs");
          const path = require("path");
          const dir = path.dirname(params.file);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(params.file, text + "\n", "utf-8");
          return { content: [{ type: "text", text: truncateToolResponse(`${text}\n\n📄 Saved to ${params.file}`, { toolName: "tmux-capture" }) }] };
        }
        return { content: [{ type: "text", text: truncateToolResponse(text, { toolName: "tmux-capture" }) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
      }
    },
  });

  // ── dev_tmux_attach ────────────────────────────────────────────────

  pi.registerTool({
    name: "pi_dev_tmux_attach",
    label: "Attach to tmux session",
    description:
      "Open a new terminal window attached to a managed tmux session in read-only mode. " +
      "The user can watch what's happening in real-time.",
    parameters: Type.Object({
      id: Type.String({ description: "Session ID" }),
    }),
    async execute(_id: string, params: { id: string }) {
      try {
        const msg = manager.attach(params.id);
        return { content: [{ type: "text", text: msg }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
      }
    },
  });

  // ── dev_tmux_close ─────────────────────────────────────────────────

  pi.registerTool({
    name: "pi_dev_tmux_close",
    label: "Close tmux session",
    description: "Kill a managed tmux session and clean up its socket.",
    parameters: Type.Object({
      id: Type.String({ description: "Session ID" }),
    }),
    async execute(_id: string, params: { id: string }, _signal: any, _onUpdate: any, ctx: any) {
      try {
        manager.close(params.id);
        updateStatus(ctx);
        return { content: [{ type: "text", text: `Session ${params.id} closed and cleaned up.` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed: ${e.message}` }], isError: true };
      }
    },
  });

  // ── dev_tmux_list ──────────────────────────────────────────────────

  pi.registerTool({
    name: "pi_dev_tmux_list",
    label: "List tmux sessions",
    description: "List all managed tmux sessions with their status (alive/dead).",
    parameters: Type.Object({}),
    async execute() {
      const sessions = manager.list();
      if (sessions.length === 0) {
        return { content: [{ type: "text", text: "No managed tmux sessions." }] };
      }
      const lines = sessions.map(
        (s) =>
          `${s.id} | ${s.sessionName} | ${s.alive ? "alive" : "dead"} | ${s.command || "(shell)"} | ${s.createdAt}`
      );
      return {
        content: [{ type: "text", text: `ID | Name | Status | Command | Created\n${lines.join("\n")}` }],
      };
    },
  });

  // ── Self-tmux tools (agent reloads/restarts itself) ────────────────

  pi.registerTool({
    name: "pi_dev_tmux_reload",
    label: "Self-reload via tmux",
    description:
      "Reload extensions by injecting /reload into the current tmux session. " +
      "Only works when pi is running inside tmux. This is a terminal operation — " +
      "the current agent turn ends when reload triggers.",
    parameters: Type.Object({
      prompt: Type.Optional(Type.String({ description: "Follow-up prompt to inject after reload completes (waits for reload to finish)" })),
      delay: Type.Optional(Type.Number({ description: "Seconds to wait after /reload before injecting prompt (default: 3)" })),
    }),
    async execute(_id: string, params: { prompt?: string; delay?: number }, _signal: any, _onUpdate: any, ctx: any) {
      if (!getSelfTmux()) {
        return { content: [{ type: "text", text: "Not running inside tmux. Cannot self-reload." }], isError: true };
      }
      const delayMs = (params.delay ?? 3) * 1000;
      // Abort the agent turn so it doesn't race with reload
      setTimeout(async () => {
        ctx.abort();
        await new Promise((r) => setTimeout(r, 200));
        injectToSelfTmux("/reload", true);
        if (params.prompt) {
          await new Promise((r) => setTimeout(r, delayMs));
          // Flatten to single line — pi's editor submits on newline
          injectToSelfTmux(params.prompt.replace(/\n+/g, " ").trim(), true);
        }
      }, 100);
      const msg = params.prompt
        ? `Injecting /reload → waiting ${delayMs / 1000}s → injecting follow-up prompt.`
        : "Injecting /reload — session will restart momentarily.";
      return { content: [{ type: "text", text: msg }] };
    },
  });

  pi.registerTool({
    name: "pi_dev_tmux_new",
    label: "Fresh session via tmux",
    description:
      "Start a fresh session by injecting /new, then inject a follow-up prompt. " +
      "Only works when pi is running inside tmux. This is a terminal operation — " +
      "the current agent turn ends and a new session begins with the given prompt.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Prompt to inject into the fresh session" }),
      delay: Type.Optional(Type.Number({ description: "Seconds to wait after /new before injecting prompt (default: 2)" })),
    }),
    async execute(_id: string, params: { prompt: string; delay?: number }, _signal: any, _onUpdate: any, ctx: any) {
      if (!getSelfTmux()) {
        return { content: [{ type: "text", text: "Not running inside tmux. Cannot self-new." }], isError: true };
      }
      const delayMs = (params.delay ?? 2) * 1000;
      // Abort agent turn, then inject /new, wait, inject prompt
      setTimeout(async () => {
        ctx.abort();
        await new Promise((r) => setTimeout(r, 200));
        injectToSelfTmux("/new", true);
        await new Promise((r) => setTimeout(r, delayMs));
        // Flatten to single line — pi's editor submits on newline
        injectToSelfTmux(params.prompt.replace(/\n+/g, " ").trim(), true);
      }, 100);
      return { content: [{ type: "text", text: `Injecting /new → waiting ${delayMs / 1000}s → injecting prompt. Session will restart.` }] };
    },
  });
}
