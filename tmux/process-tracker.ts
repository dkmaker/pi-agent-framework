/**
 * ProcessTracker — unified persistent state for all managed processes
 * (tmux sessions + spawned pi subprocesses).
 *
 * State file: /tmp/pi-developer-mode/<repo-hash>/state.json
 * Survives /reload and /new. Cleaned on pi exit (session_shutdown).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ─── Types ───────────────────────────────────────────────────────────

export interface TrackedProcess {
  id: string;
  type: "tmux" | "spawn";
  pid?: number;
  startedAt: string;
  status: "running" | "exited";

  // tmux-specific
  session?: string;
  socket?: string;
  command?: string;

  // spawn-specific
  args?: string[];
  rawLog?: string;
  exitCode?: number | null;
}

interface StateFile {
  version: number;
  processes: TrackedProcess[];
}

const STATE_VERSION = 1;

// ─── Tracker ─────────────────────────────────────────────────────────

export class ProcessTracker {
  private processes: Map<string, TrackedProcess> = new Map();
  private stateDir: string;
  private statePath: string;

  constructor() {
    const repoHash = crypto.createHash("sha256").update(process.cwd()).digest("hex").slice(0, 12);
    this.stateDir = path.join(os.tmpdir(), "pi-developer-mode", repoHash);
    this.statePath = path.join(this.stateDir, "state.json");

    this.ensureDir();
    this.load();
    this.pruneZombies();
  }

  /** Get the state directory path (used by TmuxManager for config files). */
  get dir(): string {
    return this.stateDir;
  }

  // ─── CRUD ──────────────────────────────────────────────────────────

  register(proc: TrackedProcess): void {
    this.processes.set(proc.id, proc);
    this.save();
  }

  unregister(id: string): void {
    this.processes.delete(id);
    this.save();
  }

  get(id: string): TrackedProcess | undefined {
    return this.processes.get(id);
  }

  update(id: string, patch: Partial<TrackedProcess>): void {
    const existing = this.processes.get(id);
    if (existing) {
      Object.assign(existing, patch);
      this.save();
    }
  }

  /** Get all tracked processes, optionally filtered by type. */
  all(type?: "tmux" | "spawn"): TrackedProcess[] {
    const procs = [...this.processes.values()];
    return type ? procs.filter((p) => p.type === type) : procs;
  }

  /** Get only running processes. */
  running(type?: "tmux" | "spawn"): TrackedProcess[] {
    return this.all(type).filter((p) => p.status === "running");
  }

  get count(): number {
    return this.processes.size;
  }

  get runningCount(): number {
    return this.running().length;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  /**
   * Mark a process as exited. Does NOT remove it — keeps for context.
   */
  markExited(id: string, exitCode?: number | null): void {
    this.update(id, { status: "exited", exitCode });
  }

  /**
   * Remove all tracked processes and delete the state file.
   */
  clear(): void {
    this.processes.clear();
    try {
      fs.unlinkSync(this.statePath);
    } catch { /* ignore */ }
  }

  // ─── Prompt injection ──────────────────────────────────────────────

  /**
   * Generate a prompt summary of active processes.
   * Returns empty string if nothing is running.
   */
  promptSummary(): string {
    const running = this.running();
    if (running.length === 0) return "";

    const lines = ["## Active dev processes"];
    for (const p of running) {
      const uptime = formatUptime(p.startedAt);
      if (p.type === "tmux") {
        lines.push(`- ${p.id} (tmux session "${p.session}", ${uptime}): socket ${p.socket}`);
      } else {
        const argsStr = p.args?.join(" ") ?? "";
        lines.push(`- ${p.id} (spawn, ${uptime}): ${argsStr} → raw: ${p.rawLog}`);
      }
    }
    return lines.join("\n");
  }

  // ─── Persistence ──────────────────────────────────────────────────

  private load(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        const data = JSON.parse(fs.readFileSync(this.statePath, "utf-8")) as StateFile;
        if (data.version > STATE_VERSION) {
          // Silently ignore newer state versions
          return;
        }
        // Migrate older versions here if needed in the future
        if (Array.isArray(data.processes)) {
          for (const proc of data.processes) {
            this.processes.set(proc.id, proc);
          }
        }
      }
    } catch (e) {
      // Silently ignore corrupted state
    }
  }

  save(): void {
    this.ensureDir();
    const state: StateFile = {
      version: STATE_VERSION,
      processes: [...this.processes.values()],
    };
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.stateDir)) {
      fs.mkdirSync(this.stateDir, { recursive: true });
    }
  }

  // ─── Zombie detection ─────────────────────────────────────────────

  private pruneZombies(): void {
    let pruned = 0;
    for (const proc of this.processes.values()) {
      if (proc.status !== "running") continue;

      if (proc.type === "tmux") {
        // Check if tmux session is alive via socket
        if (proc.socket && !this.isTmuxAlive(proc)) {
          proc.status = "exited";
          pruned++;
        }
      } else if (proc.type === "spawn") {
        // Check PID
        if (proc.pid && !this.isPidAlive(proc.pid)) {
          proc.status = "exited";
          pruned++;
        }
      }
    }
    if (pruned > 0) {
      this.save();
    }
  }

  private isTmuxAlive(proc: TrackedProcess): boolean {
    try {
      const { execSync } = require("child_process");
      execSync(`tmux -S '${proc.socket!.replace(/'/g, "'\\''")}' has-session -t '${proc.session!.replace(/'/g, "'\\''")}'`, {
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  }

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function formatUptime(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${mins % 60}m`;
}
