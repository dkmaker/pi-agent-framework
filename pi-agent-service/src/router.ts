/**
 * MessageRouter — ACL enforcement, threading, queuing, and delivery tracking.
 *
 * Handles message routing between agents and manager. Does NOT deliver to sessions
 * directly — that's AgentManager's responsibility. The router queues messages and
 * provides drain/delivery APIs.
 *
 * References: assets [i5eisc9o], [ik1yp2tc], [f5z68c4v]
 */

import { nanoid } from "nanoid";
import type { SettingsLoader } from "./settings.js";
import type { TraceWriter } from "./trace.js";
import type { Message, MessageResult, ThreadSummary, TraceEntry } from "./types.js";

export interface SendMessageOpts {
  from: string;
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  replyTo?: string;
  priority?: "normal" | "important";
  delivery?: "persist" | "online-only";
}

const THREAD_MESSAGE_LIMIT = 100;

export class MessageRouter {
  /** Per-agent message queues (pending delivery) */
  private queues: Map<string, Message[]> = new Map();

  /** Thread metadata */
  private threads: Map<
    string,
    { participants: Set<string>; messageCount: number; lastActivity: string; subject: string }
  > = new Map();

  /** Message stats per agent */
  private stats: Map<string, { sent: number; received: number; unread: number }> = new Map();

  constructor(
    private trace: TraceWriter,
    private settings: SettingsLoader,
  ) {}

  /**
   * Send a message. ACL-checked, thread-assigned, traced, and queued.
   * Returns the result — does NOT deliver to session.
   */
  sendMessage(opts: SendMessageOpts): MessageResult {
    // ACL check
    if (!this.checkAcl(opts.from, opts.to)) {
      // Trace dropped message
      const msg = this.buildMessage(opts, "dropped");
      this.trace.append({
        type: "message",
        messageId: msg.messageId,
        threadId: msg.threadId,
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        body: msg.body,
        priority: msg.priority,
        delivery: msg.delivery,
        status: "dropped",
      });

      return { messageId: msg.messageId, threadId: msg.threadId, status: "dropped" };
    }

    // Check thread limit
    if (opts.threadId) {
      const thread = this.threads.get(opts.threadId);
      if (thread && thread.messageCount >= THREAD_MESSAGE_LIMIT) {
        throw new RouterError("THREAD_LIMIT", `Thread ${opts.threadId} has reached ${THREAD_MESSAGE_LIMIT} messages`);
      }
    }

    // Build message
    const msg = this.buildMessage(opts, "queued");

    // Update thread metadata
    this.updateThread(msg);

    // Update stats
    this.incrementStat(msg.from, "sent");
    this.incrementStat(msg.to, "received");
    this.incrementStat(msg.to, "unread");

    // Trace
    this.trace.append({
      type: "message",
      messageId: msg.messageId,
      threadId: msg.threadId,
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      body: msg.body,
      priority: msg.priority,
      delivery: msg.delivery,
      replyTo: msg.replyTo,
      status: "queued",
    });

    // Queue
    this.enqueue(msg.to, msg);

    return { messageId: msg.messageId, threadId: msg.threadId, status: "queued" };
  }

  /**
   * Drain the oldest message from an agent's queue.
   * Returns undefined if queue is empty.
   */
  drainQueue(agentName: string): Message | undefined {
    const queue = this.queues.get(agentName);
    if (!queue || queue.length === 0) return undefined;

    const msg = queue.shift()!;
    msg.status = "delivered";

    // Trace delivery
    this.trace.append({
      type: "message_status",
      messageId: msg.messageId,
      status: "delivered",
    });

    return msg;
  }

  /**
   * Get all queued messages for an agent (without removing).
   */
  peekQueue(agentName: string): Message[] {
    return [...(this.queues.get(agentName) ?? [])];
  }

  /**
   * Get queue length for an agent.
   */
  queueLength(agentName: string): number {
    return this.queues.get(agentName)?.length ?? 0;
  }

  /**
   * Check if an agent has important messages queued.
   */
  hasImportantMessages(agentName: string): boolean {
    const queue = this.queues.get(agentName);
    return queue?.some((m) => m.priority === "important") ?? false;
  }

  /**
   * Get the next important message from queue (removes it).
   */
  drainImportant(agentName: string): Message | undefined {
    const queue = this.queues.get(agentName);
    if (!queue) return undefined;

    const idx = queue.findIndex((m) => m.priority === "important");
    if (idx === -1) return undefined;

    const [msg] = queue.splice(idx, 1);
    msg.status = "delivered";

    this.trace.append({
      type: "message_status",
      messageId: msg.messageId,
      status: "delivered",
    });

    return msg;
  }

  /**
   * Mark unread count decremented for an agent.
   */
  markRead(agentName: string, count: number = 1): void {
    const stat = this.stats.get(agentName);
    if (stat) {
      stat.unread = Math.max(0, stat.unread - count);
    }
  }

  /**
   * Query messages from trace (not from queue — historical).
   */
  getMessages(opts: { agent?: string; threadId?: string; limit?: number; before?: string }): Message[] {
    const entries = this.trace.query({
      type: "message",
      agent: opts.agent,
      threadId: opts.threadId,
      limit: opts.limit ?? 10,
      before: opts.before,
    });

    return entries.map((e) => ({
      messageId: (e as any).messageId,
      threadId: (e as any).threadId,
      from: (e as any).from,
      to: (e as any).to,
      subject: (e as any).subject,
      body: (e as any).body,
      priority: (e as any).priority ?? "normal",
      delivery: (e as any).delivery ?? "persist",
      replyTo: (e as any).replyTo,
      timestamp: e.ts,
      status: (e as any).status,
    }));
  }

  /**
   * Get thread summaries.
   */
  getThreads(opts: { agent?: string } = {}): ThreadSummary[] {
    const result: ThreadSummary[] = [];
    for (const [threadId, meta] of this.threads) {
      if (opts.agent && !meta.participants.has(opts.agent)) continue;
      result.push({
        threadId,
        participants: Array.from(meta.participants),
        messageCount: meta.messageCount,
        lastActivity: meta.lastActivity,
        subject: meta.subject,
      });
    }
    return result;
  }

  /**
   * Get message stats for an agent.
   */
  getStats(agentName: string): { sent: number; received: number; unread: number } {
    return { sent: 0, received: 0, unread: 0, ...this.stats.get(agentName) };
  }

  /**
   * Restore queues and threads from trace entries (for state recovery).
   */
  restoreFromTrace(entries: TraceEntry[]): void {
    const delivered = new Set<string>();

    // First pass: collect delivered message IDs
    for (const e of entries) {
      if (e.type === "message_status" && (e as any).status === "delivered") {
        delivered.add((e as any).messageId);
      }
    }

    // Second pass: rebuild queues and threads
    for (const e of entries) {
      if (e.type !== "message") continue;
      const msg = e as any;

      // Rebuild thread metadata
      this.updateThread({
        threadId: msg.threadId,
        from: msg.from,
        to: msg.to,
        subject: msg.subject,
        timestamp: e.ts,
      } as Message);

      // Re-queue undelivered persist messages
      if (msg.status === "queued" && !delivered.has(msg.messageId) && msg.delivery !== "online-only") {
        this.enqueue(msg.to, {
          messageId: msg.messageId,
          threadId: msg.threadId,
          from: msg.from,
          to: msg.to,
          subject: msg.subject,
          body: msg.body,
          priority: msg.priority ?? "normal",
          delivery: msg.delivery ?? "persist",
          replyTo: msg.replyTo,
          timestamp: e.ts,
          status: "queued",
        });
      }
    }
  }

  // ─── Internal ───────────────────────────────────────────────────

  private checkAcl(from: string, to: string): boolean {
    // Manager can always send/receive
    if (from === "manager" || to === "manager") return true;

    const acl = this.settings.getAcl();
    const rule = acl.find((r) => r.from === from);
    return rule?.to.includes(to) ?? false;
  }

  private buildMessage(opts: SendMessageOpts, status: Message["status"]): Message {
    const threadId = opts.threadId ?? nanoid();
    return {
      messageId: nanoid(),
      threadId,
      from: opts.from,
      to: opts.to,
      subject: opts.subject,
      body: opts.body,
      priority: opts.priority ?? "normal",
      delivery: opts.delivery ?? "persist",
      replyTo: opts.replyTo,
      timestamp: new Date().toISOString(),
      status,
    };
  }

  private enqueue(agentName: string, msg: Message): void {
    if (!this.queues.has(agentName)) {
      this.queues.set(agentName, []);
    }
    this.queues.get(agentName)?.push(msg);
  }

  private updateThread(msg: Pick<Message, "threadId" | "from" | "to" | "subject" | "timestamp">): void {
    const existing = this.threads.get(msg.threadId);
    if (existing) {
      existing.participants.add(msg.from);
      existing.participants.add(msg.to);
      existing.messageCount++;
      existing.lastActivity = msg.timestamp;
    } else {
      this.threads.set(msg.threadId, {
        participants: new Set([msg.from, msg.to]),
        messageCount: 1,
        lastActivity: msg.timestamp,
        subject: msg.subject,
      });
    }
  }

  private incrementStat(agent: string, field: "sent" | "received" | "unread"): void {
    if (!this.stats.has(agent)) {
      this.stats.set(agent, { sent: 0, received: 0, unread: 0 });
    }
    this.stats.get(agent)![field]++;
  }
}

export class RouterError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "RouterError";
  }
}
