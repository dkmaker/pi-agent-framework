/**
 * CutoffMonitor — per-agent context usage tracking with polite and hard cutoff.
 *
 * - Polite cutoff (default 70%): enqueues warning message on agent_end
 * - Hard cutoff (default 90%): sets hardSteering flag, steers on tool_execution_end
 * - Reset on context_handoff
 *
 * Reference: asset [ik1yp2tc]
 */

import type { TraceEntry } from "./types.js";
import type { TraceWriter } from "./trace.js";

export interface CutoffState {
  politeWarned: boolean;
  hardSteering: boolean;
}

export interface CutoffWarningEvent {
  agent: string;
  percent: number;
  level: "polite" | "hard";
}

export class CutoffMonitor {
  private states: Map<string, CutoffState> = new Map();
  private listeners: Array<(event: CutoffWarningEvent) => void> = [];

  constructor(private trace: TraceWriter) {}

  /**
   * Check context usage on agent_end. Returns a warning message to enqueue, or null.
   */
  checkOnAgentEnd(
    agentName: string,
    contextPercent: number,
    politePct: number,
    hardPct: number,
  ): { message: string; level: "polite" | "hard" } | null {
    const state = this.getState(agentName);

    // Hard cutoff check
    if (contextPercent >= hardPct) {
      state.hardSteering = true;

      this.trace.append({
        type: "context_warning",
        agent: agentName,
        percent: contextPercent,
        level: "hard",
      });

      this.notifyListeners({ agent: agentName, percent: contextPercent, level: "hard" });

      return {
        message: `STOP. Your context is at ${contextPercent}%. Call context_handoff NOW.`,
        level: "hard",
      };
    }

    // Polite cutoff check
    if (contextPercent >= politePct && !state.politeWarned) {
      state.politeWarned = true;

      this.trace.append({
        type: "context_warning",
        agent: agentName,
        percent: contextPercent,
        level: "polite",
      });

      this.notifyListeners({ agent: agentName, percent: contextPercent, level: "polite" });

      return {
        message: `Your context is at ${contextPercent}%. Please wrap up your current work and call context_handoff with a summary and continue message.`,
        level: "polite",
      };
    }

    return null;
  }

  /**
   * Check if hard steering is active for an agent.
   * Called on tool_execution_end to decide whether to steer.
   */
  isHardSteering(agentName: string): boolean {
    return this.getState(agentName).hardSteering;
  }

  /**
   * Get the steering message for hard cutoff.
   */
  getSteerMessage(agentName: string, contextPercent: number): string {
    return `STOP. Context at ${contextPercent}%. Call context_handoff NOW.`;
  }

  /**
   * Reset cutoff state for an agent (after context_handoff / newSession).
   */
  reset(agentName: string): void {
    this.states.set(agentName, { politeWarned: false, hardSteering: false });
  }

  /**
   * Register a listener for cutoff warnings.
   */
  onWarning(listener: (event: CutoffWarningEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  dispose(): void {
    this.states.clear();
    this.listeners.length = 0;
  }

  // ─── Internal ───────────────────────────────────────────────────

  private getState(agentName: string): CutoffState {
    let state = this.states.get(agentName);
    if (!state) {
      state = { politeWarned: false, hardSteering: false };
      this.states.set(agentName, state);
    }
    return state;
  }

  private notifyListeners(event: CutoffWarningEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
