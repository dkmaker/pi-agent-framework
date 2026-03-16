/**
 * SubscriptionManager — bounded event delivery for the manager.
 *
 * Manager-only. Agents do NOT subscribe — they receive messages.
 * Subscriptions auto-expire when maxEvents is reached.
 * Max 20 active subscriptions.
 *
 * Reference: asset [il2m3sl0]
 */

import { nanoid } from "nanoid";
import type { EventFilter, Subscription, TraceEntry } from "./types.js";

const MAX_SUBSCRIPTIONS = 20;

export interface SubscriptionEvent {
  subscriptionId: string;
  entry: TraceEntry;
  subscriptionExpired: boolean;
}

export class SubscriptionManager {
  private subscriptions: Map<string, Subscription> = new Map();
  private listeners: Array<(event: SubscriptionEvent) => void> = [];

  /**
   * Create a new subscription. Returns the subscription ID.
   */
  subscribe(filter: EventFilter, maxEvents: number): string {
    // Check limit
    const activeCount = Array.from(this.subscriptions.values()).filter((s) => s.status === "active").length;
    if (activeCount >= MAX_SUBSCRIPTIONS) {
      throw new Error(`Maximum ${MAX_SUBSCRIPTIONS} active subscriptions reached`);
    }

    const id = nanoid();
    this.subscriptions.set(id, {
      id,
      filter,
      maxEvents,
      deliveredCount: 0,
      status: "active",
    });
    return id;
  }

  /**
   * Cancel a subscription.
   */
  unsubscribe(id: string): boolean {
    const sub = this.subscriptions.get(id);
    if (!sub || sub.status !== "active") return false;
    sub.status = "cancelled";
    return true;
  }

  /**
   * Get all subscriptions.
   */
  getSubscriptions(): Subscription[] {
    return Array.from(this.subscriptions.values());
  }

  /**
   * Get active subscriptions only.
   */
  getActiveSubscriptions(): Subscription[] {
    return Array.from(this.subscriptions.values()).filter((s) => s.status === "active");
  }

  /**
   * Match a trace entry against all active subscriptions.
   * Delivers to matching subscriptions, increments counters, auto-expires.
   * Returns matched subscription events.
   */
  match(entry: TraceEntry): SubscriptionEvent[] {
    const events: SubscriptionEvent[] = [];

    for (const sub of this.subscriptions.values()) {
      if (sub.status !== "active") continue;
      if (!this.matchesFilter(entry, sub.filter)) continue;

      sub.deliveredCount++;
      const expired = sub.deliveredCount >= sub.maxEvents;
      if (expired) {
        sub.status = "expired";
      }

      const event: SubscriptionEvent = {
        subscriptionId: sub.id,
        entry,
        subscriptionExpired: expired,
      };
      events.push(event);

      // Notify listeners
      for (const listener of this.listeners) {
        listener(event);
      }
    }

    return events;
  }

  /**
   * Cancel all active subscriptions (e.g., on manager disconnect).
   */
  cancelAll(): void {
    for (const sub of this.subscriptions.values()) {
      if (sub.status === "active") {
        sub.status = "cancelled";
      }
    }
  }

  /**
   * Register a listener for subscription events.
   */
  onEvent(listener: (event: SubscriptionEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  dispose(): void {
    this.subscriptions.clear();
    this.listeners.length = 0;
  }

  // ─── Internal ───────────────────────────────────────────────────

  private matchesFilter(entry: TraceEntry, filter: EventFilter): boolean {
    // Type filter
    if (filter.types && filter.types.length > 0) {
      if (!filter.types.includes(entry.type)) return false;
    }

    // Agent filter
    if (filter.agent) {
      const entryAgent = (entry as any).agent ?? (entry as any).from ?? (entry as any).to;
      if (entryAgent !== filter.agent) return false;
    }

    // Thread filter
    if (filter.threadId) {
      if ((entry as any).threadId !== filter.threadId) return false;
    }

    return true;
  }
}
