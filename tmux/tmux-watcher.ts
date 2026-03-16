/**
 * TmuxWatcher — polls managed tmux sessions for idle state transitions.
 *
 * Detects when a child pi session transitions from "working" to "idle"
 * (a turn-end event) and fires a callback with a pane capture.
 *
 * One-directional: only the parent watches the child. No reverse channel.
 */

import type { TmuxManager } from "./tmux-manager";
import { readFileSync, unlinkSync } from "fs";

export interface RelayStatus {
  pid: number;
  timestamp: string;
  state: "working" | "idle" | "blocked" | "shutdown";
  blockReason?: string;
  tokenPct?: number;
  lastTool?: string;
  lastToolParams?: Record<string, unknown>;
  turnCount: number;
}

export interface WatchCallback {
  (event: TmuxTurnEndEvent): void;
}

export interface RelayCallback {
  (sessionId: string, status: RelayStatus): void;
}

export interface TmuxTurnEndEvent {
  sessionId: string;
  capture: string;
  /** Number of turn-ends detected so far for this session. */
  turnCount: number;
  /** Whether the session is still alive. */
  alive: boolean;
}

interface WatchedSession {
  sessionId: string;
  callback: WatchCallback;
  relayCallback?: RelayCallback;
  interval: ReturnType<typeof setInterval>;
  wasWorking: boolean;
  turnCount: number;
  lastRelayTimestamp?: string;
  stopped: boolean;
}

// ─── Idle detection heuristics ───────────────────────────────────────

/** Pi shows a spinner (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) + "Working..." when active. */
const WORKING_PATTERN = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Working/;

/** Pi shows the input separator lines when idle and ready for input. */
const IDLE_PATTERN = /^─{10,}$/m;

function isWorking(capture: string): boolean {
  return WORKING_PATTERN.test(capture);
}

function isIdle(capture: string): boolean {
  // Idle = has separator lines AND no working spinner
  return IDLE_PATTERN.test(capture) && !isWorking(capture);
}

// ─── Watcher ─────────────────────────────────────────────────────────

const DEFAULT_POLL_MS = 1000;

export class TmuxWatcher {
  private watched = new Map<string, WatchedSession>();
  private manager: TmuxManager;
  private pollMs: number;

  constructor(manager: TmuxManager, pollMs: number = DEFAULT_POLL_MS) {
    this.manager = manager;
    this.pollMs = pollMs;
  }

  /**
   * Start watching a managed tmux session for turn-end events.
   * Callback fires each time the child transitions from working → idle.
   * Optional relayCallback fires on relay status file changes (live feedback).
   */
  watch(sessionId: string, callback: WatchCallback, relayCallback?: RelayCallback): void {
    // Don't double-watch
    if (this.watched.has(sessionId)) {
      this.unwatch(sessionId);
    }

    const entry: WatchedSession = {
      sessionId,
      callback,
      relayCallback,
      wasWorking: false,
      turnCount: 0,
      stopped: false,
      interval: setInterval(() => this.poll(sessionId), this.pollMs),
    };

    this.watched.set(sessionId, entry);

  }

  /** Stop watching a session. Clean up relay status file. */
  unwatch(sessionId: string): void {
    const entry = this.watched.get(sessionId);
    if (entry) {
      entry.stopped = true;
      clearInterval(entry.interval);
      this.watched.delete(sessionId);
      // Clean up relay status file
      try { unlinkSync(`/tmp/pi-relay-${sessionId}.json`); } catch { /* ignore */ }

    }
  }

  /** Stop watching all sessions. */
  unwatchAll(): void {
    for (const id of [...this.watched.keys()]) {
      this.unwatch(id);
    }
  }

  /** Get list of watched session IDs. */
  get watchedSessions(): string[] {
    return [...this.watched.keys()];
  }

  // ─── Internal ────────────────────────────────────────────────────

  private poll(sessionId: string): void {
    const entry = this.watched.get(sessionId);
    if (!entry || entry.stopped) return;

    let capture: string;
    let alive = true;

    try {
      capture = this.manager.capture(sessionId, 30);
    } catch {
      // Session is dead
      alive = false;
      capture = "";
      // Fire one final event and unwatch
      entry.callback({
        sessionId,
        capture: "(session ended)",
        turnCount: entry.turnCount,
        alive: false,
      });
      this.unwatch(sessionId);
      return;
    }

    // Poll relay status file for live feedback
    if (entry.relayCallback) {
      this.pollRelay(entry);
    }

    // Old visual heuristic turn-end detection — only used as fallback
    // when no relay is active (relay handles turn-end via state transitions)
    if (!entry.relayCallback) {
      const working = isWorking(capture);
      const idle = isIdle(capture);

      if (entry.wasWorking && idle) {
        entry.turnCount++;
        entry.callback({
          sessionId,
          capture,
          turnCount: entry.turnCount,
          alive,
        });
      }

      entry.wasWorking = working;
    }
  }

  private pollRelay(entry: WatchedSession): void {
    const statusFile = `/tmp/pi-relay-${entry.sessionId}.json`;
    try {
      const raw = readFileSync(statusFile, "utf-8").trim();
      const status: RelayStatus = JSON.parse(raw);
      // Only fire callback if timestamp changed
      if (status.timestamp !== entry.lastRelayTimestamp) {
        const prevTimestamp = entry.lastRelayTimestamp;
        entry.lastRelayTimestamp = status.timestamp;
        entry.relayCallback!(entry.sessionId, status);

        // Relay-driven turn-end: working/blocked → idle transition
        if (prevTimestamp && status.state === "idle") {
          entry.turnCount = status.turnCount || entry.turnCount + 1;
          try {
            const capture = this.manager.capture(entry.sessionId, 30);
            entry.callback({
              sessionId: entry.sessionId,
              capture,
              turnCount: entry.turnCount,
              alive: true,
            });
          } catch { /* session died — handled by main poll */ }
        }
      }
    } catch {
      // File doesn't exist yet or parse error — ignore
    }
  }
}
