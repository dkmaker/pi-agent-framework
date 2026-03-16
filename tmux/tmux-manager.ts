/**
 * TmuxManager — manages tmux sessions as a first-class capability.
 *
 * Each managed session uses:
 * - A shared socket at <socketPrefix>-<id> for isolation
 * - An embedded tmux config optimized for pi (extended-keys, csi-u)
 * - State persistence delegated to ProcessTracker
 */

import { execSync, spawn as cpSpawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { DeveloperModeConfig } from "./config";
import { resolveTerminal } from "./config";
import type { ProcessTracker, TrackedProcess } from "./process-tracker";

// ─── Types ───────────────────────────────────────────────────────────

export interface ManagedSession {
  id: string;
  sessionName: string;
  socket: string;
  command?: string;
  createdAt: string;
  pid?: number;
}

// ─── Embedded tmux config ────────────────────────────────────────────

const EMBEDDED_TMUX_CONF = `
# Pi developer-mode embedded tmux config
# Optimized for pi keyboard protocol support

# Extended keys for modifier detection (Shift+Enter, Ctrl+Enter, etc.)
set -g extended-keys on
set -g extended-keys-format csi-u

# Modern terminal features
set -g default-terminal "tmux-256color"
set -as terminal-features ',xterm-256color:RGB'

# Mouse support
set -g mouse on

# Increase scrollback
set -g history-limit 50000

# No escape delay (important for pi responsiveness)
set -sg escape-time 0

# Minimal status bar for managed sessions
set -g status-style 'bg=#1a1a2e,fg=#8888aa'
set -g status-left '[pi-dev] '
set -g status-left-length 20
set -g status-right '%H:%M'
`.trim();

// ─── Manager ─────────────────────────────────────────────────────────

export class TmuxManager {
  private config: DeveloperModeConfig;
  private tracker: ProcessTracker;
  private confPath: string;

  constructor(config: DeveloperModeConfig, tracker: ProcessTracker) {
    this.config = config;
    this.tracker = tracker;

    // Write embedded tmux config to the tracker's state directory
    this.confPath = path.join(tracker.dir, "tmux.conf");
    fs.writeFileSync(this.confPath, EMBEDDED_TMUX_CONF + "\n", "utf-8");
  }

  // ─── Internal helpers ────────────────────────────────────────────

  /** Convert a TrackedProcess to a ManagedSession view. */
  private toSession(proc: TrackedProcess): ManagedSession {
    return {
      id: proc.id,
      sessionName: proc.session!,
      socket: proc.socket!,
      command: proc.command,
      createdAt: proc.startedAt,
      pid: proc.pid,
    };
  }

  /** Get all tmux TrackedProcesses that are still running. */
  private tmuxProcs(): TrackedProcess[] {
    return this.tracker.running("tmux");
  }

  private getProc(id: string): TrackedProcess {
    const proc = this.tracker.get(id);
    if (!proc || proc.type !== "tmux") {
      const available = this.tmuxProcs().map((p) => p.id).join(", ") || "(none)";
      throw new Error(`No managed tmux session with id "${id}". Active sessions: ${available}`);
    }
    return proc;
  }

  // ─── Public API ──────────────────────────────────────────────────

  spawn(options: { command?: string; name?: string; relayExtPath?: string } = {}): ManagedSession {
    const id = crypto.randomUUID().slice(0, 8);
    const sessionName = options.name || `pi-dev-${id}`;
    const socket = `${this.config.tmux.socketPrefix}-${id}`;

    let cmd = options.command || process.env.SHELL || "/bin/bash";

    // Inject relay extension when explicitly requested
    if (options.relayExtPath && fs.existsSync(options.relayExtPath)) {
      cmd = `PI_RELAY_ID=${id} ${cmd} -e ${options.relayExtPath}`;
    }

    const tmuxArgs = [
      "-f", this.confPath,
      "-S", socket,
      "new-session",
      "-d",
      "-s", sessionName,
      cmd,
    ];

    execSync(`tmux ${tmuxArgs.map(a => this.shellEscape(a)).join(" ")}`, {
      stdio: "ignore",
    });

    let pid: number | undefined;
    try {
      const pidStr = execSync(`tmux -S ${this.shellEscape(socket)} display-message -p '#{pid}'`, {
        encoding: "utf-8",
      }).trim();
      pid = parseInt(pidStr, 10) || undefined;
    } catch { /* non-critical */ }

    const proc: TrackedProcess = {
      id,
      type: "tmux",
      pid,
      startedAt: new Date().toISOString(),
      status: "running",
      session: sessionName,
      socket,
      command: options.command,
    };

    this.tracker.register(proc);
    return this.toSession(proc);
  }

  send(id: string, keys: string): void {
    const proc = this.getProc(id);
    execSync(
      `tmux -S ${this.shellEscape(proc.socket!)} send-keys -t ${this.shellEscape(proc.session!)} ${this.shellEscape(keys)}`,
      { stdio: "ignore" }
    );
  }

  inject(id: string, content: string, submit: boolean = false): void {
    const proc = this.getProc(id);
    const tmpFile = path.join(this.tracker.dir, `inject-${id}.tmp`);

    try {
      fs.writeFileSync(tmpFile, content, "utf-8");
      execSync(
        `tmux -S ${this.shellEscape(proc.socket!)} load-buffer ${this.shellEscape(tmpFile)}`,
        { stdio: "ignore" }
      );
      execSync(
        `tmux -S ${this.shellEscape(proc.socket!)} paste-buffer -t ${this.shellEscape(proc.session!)}`,
        { stdio: "ignore" }
      );
      if (submit) {
        execSync(
          `tmux -S ${this.shellEscape(proc.socket!)} send-keys -t ${this.shellEscape(proc.session!)} Enter`,
          { stdio: "ignore" }
        );
      }
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  capture(id: string, lines?: number): string {
    const proc = this.getProc(id);
    const startArg = lines ? `-S -${lines}` : "";
    const output = execSync(
      `tmux -S ${this.shellEscape(proc.socket!)} capture-pane -t ${this.shellEscape(proc.session!)} -p ${startArg}`,
      { encoding: "utf-8" }
    );
    return output.trimEnd();
  }

  attach(id: string): string {
    const proc = this.getProc(id);
    const terminal = resolveTerminal(this.config);
    const tmuxCmd = `tmux -S ${this.shellEscape(proc.socket!)} attach -t ${this.shellEscape(proc.session!)} -r`;

    let terminalCmd: string[];
    switch (terminal) {
      case "kitty":
        terminalCmd = ["kitty", "--title", `pi-dev: ${proc.session}`, "-e", "sh", "-c", tmuxCmd];
        break;
      case "gnome-terminal":
        terminalCmd = ["gnome-terminal", "--title", `pi-dev: ${proc.session}`, "--", "sh", "-c", tmuxCmd];
        break;
      case "xfce4-terminal":
        terminalCmd = ["xfce4-terminal", "--title", `pi-dev: ${proc.session}`, "-e", tmuxCmd];
        break;
      case "konsole":
        terminalCmd = ["konsole", "--title", `pi-dev: ${proc.session}`, "-e", "sh", "-c", tmuxCmd];
        break;
      default:
        terminalCmd = ["xterm", "-title", `pi-dev: ${proc.session}`, "-e", tmuxCmd];
        break;
    }

    const child = cpSpawn(terminalCmd[0], terminalCmd.slice(1), {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    return `Opened ${terminal} window attached to session ${proc.session} (read-only)`;
  }

  close(id: string): void {
    const proc = this.getProc(id);
    try {
      execSync(
        `tmux -S ${this.shellEscape(proc.socket!)} kill-session -t ${this.shellEscape(proc.session!)}`,
        { stdio: "ignore" }
      );
    } catch { /* Session may already be dead */ }
    try { fs.unlinkSync(proc.socket!); } catch { /* ignore */ }

    this.tracker.unregister(id);
  }

  list(): Array<ManagedSession & { alive: boolean }> {
    const result: Array<ManagedSession & { alive: boolean }> = [];
    for (const proc of this.tracker.all("tmux")) {
      result.push({
        ...this.toSession(proc),
        alive: proc.status === "running" && this.isAlive(proc),
      });
    }
    return result;
  }

  closeAll(): number {
    let count = 0;
    for (const proc of this.tmuxProcs()) {
      try {
        this.close(proc.id);
        count++;
      } catch { /* ignore */ }
    }
    return count;
  }

  get sessionCount(): number {
    return this.tmuxProcs().length;
  }

  // ─── Internal ────────────────────────────────────────────────────

  private isAlive(proc: TrackedProcess): boolean {
    try {
      execSync(
        `tmux -S ${this.shellEscape(proc.socket!)} has-session -t ${this.shellEscape(proc.session!)}`,
        { stdio: "ignore" }
      );
      return true;
    } catch {
      return false;
    }
  }

  private shellEscape(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
}
