/**
 * HealthMonitor — per-agent health detection based on token gap timing.
 *
 * Health states:
 * - healthy: token gap < 10s
 * - slow: token gap 10-60s
 * - stuck: token gap > 60s, or no events for 120s while working
 *
 * Reference: asset [ik1yp2tc]
 */

import type { TraceWriter } from "./trace.js";
import type { AgentHealth } from "./types.js";

const HEALTH_CHECK_INTERVAL = 5_000; // 5 seconds
const SLOW_THRESHOLD = 10_000; // 10 seconds
const STUCK_THRESHOLD = 60_000; // 60 seconds
const _NO_EVENT_THRESHOLD = 120_000; // 120 seconds

export interface HealthChangeEvent {
  agent: string;
  from: AgentHealth;
  to: AgentHealth;
}

export class HealthMonitor {
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private lastTokenTimes: Map<string, number> = new Map();
  private currentHealth: Map<string, AgentHealth> = new Map();
  private listeners: Array<(event: HealthChangeEvent) => void> = [];

  constructor(private trace: TraceWriter) {}

  /**
   * Start monitoring an agent. Called on agent_start.
   */
  start(agentName: string): void {
    // Reset state
    this.lastTokenTimes.set(agentName, Date.now());
    this.currentHealth.set(agentName, "healthy");

    // Stop existing timer if any
    this.stop(agentName);

    const timer = setInterval(() => {
      this.check(agentName);
    }, HEALTH_CHECK_INTERVAL);

    this.timers.set(agentName, timer);
  }

  /**
   * Stop monitoring an agent. Called on agent_end or stopAgent.
   */
  stop(agentName: string): void {
    const timer = this.timers.get(agentName);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(agentName);
    }
  }

  /**
   * Record a token event (text_delta). Resets the gap timer.
   */
  recordToken(agentName: string): void {
    this.lastTokenTimes.set(agentName, Date.now());
  }

  /**
   * Get current health for an agent.
   */
  getHealth(agentName: string): AgentHealth {
    return this.currentHealth.get(agentName) ?? "healthy";
  }

  /**
   * Register a listener for health changes.
   */
  onHealthChange(listener: (event: HealthChangeEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /**
   * Stop all timers and clean up.
   */
  dispose(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
    this.listeners.length = 0;
  }

  // ─── Internal ───────────────────────────────────────────────────

  private check(agentName: string): void {
    const lastToken = this.lastTokenTimes.get(agentName) ?? Date.now();
    const gap = Date.now() - lastToken;

    let newHealth: AgentHealth;
    if (gap > STUCK_THRESHOLD) {
      newHealth = "stuck";
    } else if (gap > SLOW_THRESHOLD) {
      newHealth = "slow";
    } else {
      newHealth = "healthy";
    }

    const current = this.currentHealth.get(agentName) ?? "healthy";
    if (newHealth !== current) {
      this.currentHealth.set(agentName, newHealth);

      // Trace
      this.trace.append({
        type: "agent_health",
        agent: agentName,
        from: current,
        to: newHealth,
      });

      // Notify listeners
      const event: HealthChangeEvent = { agent: agentName, from: current, to: newHealth };
      for (const listener of this.listeners) {
        listener(event);
      }
    }
  }
}
