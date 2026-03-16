/**
 * MessageQueue — per-agent message queue with threading, priority, and delivery tracking.
 * Transport-agnostic — no socket/protocol knowledge.
 */

import { randomUUID } from "crypto";
import type { Message, Thread, AgentState } from "./types.js";
import { MAX_THREAD_MESSAGES } from "./types.js";
import { Trace } from "./trace.js";

export class MessageQueue {
  private queues = new Map<string, Message[]>();       // per-agent queues
  private threads = new Map<string, Thread>();          // thread state
  private allMessages = new Map<string, Message>();     // all messages by ID
  private trace: Trace;

  constructor(trace: Trace) {
    this.trace = trace;
  }

  /**
   * Send a message. Returns the message or an error string.
   */
  send(opts: {
    from: string;
    to: string;
    subject: string;
    body: string;
    priority?: "normal" | "important";
    delivery?: "persist" | "online-only";
    replyTo?: string;
    threadId?: string;
    agentState?: AgentState;
  }): Message | string {
    const threadId = opts.threadId || `${opts.from}-${Date.now()}`;
    const priority = opts.priority || "normal";
    const delivery = opts.delivery || "persist";

    // Thread check
    const thread = this.threads.get(threadId);
    if (thread && thread.messageCount >= MAX_THREAD_MESSAGES) {
      this.trace.append({
        type: "thread_exhausted",
        threadId,
        count: thread.messageCount,
        timestamp: Date.now(),
      });
      return `Thread "${threadId}" has ${thread.messageCount} messages (limit: ${MAX_THREAD_MESSAGES}). Start a new thread.`;
    }

    const message: Message = {
      id: randomUUID(),
      threadId,
      from: opts.from,
      to: opts.to,
      subject: opts.subject,
      body: opts.body,
      priority,
      delivery,
      replyTo: opts.replyTo,
      timestamp: Date.now(),
      status: "queued",
    };

    // Online-only check
    if (delivery === "online-only" && opts.agentState === "offline") {
      message.status = "failed";
      this.allMessages.set(message.id, message);
      this.trace.append({ type: "message", message });
      this.trace.append({ type: "delivery", messageId: message.id, status: "failed", timestamp: Date.now() });
      return message; // Still returned, still traced, just failed
    }

    // Update thread
    if (!thread) {
      const newThread: Thread = {
        id: threadId,
        subject: opts.subject,
        participants: [opts.from, opts.to],
        messageCount: 1,
        createdAt: Date.now(),
        lastActivity: Date.now(),
      };
      this.threads.set(threadId, newThread);
      this.trace.append({ type: "thread_created", threadId, participants: newThread.participants, timestamp: Date.now() });
    } else {
      thread.messageCount++;
      thread.lastActivity = Date.now();
      if (!thread.participants.includes(opts.from)) thread.participants.push(opts.from);
      if (!thread.participants.includes(opts.to)) thread.participants.push(opts.to);
    }

    // Enqueue
    this.allMessages.set(message.id, message);
    const queue = this.queues.get(opts.to) || [];
    if (priority === "important") {
      queue.unshift(message); // front of queue
    } else {
      queue.push(message);
    }
    this.queues.set(opts.to, queue);

    this.trace.append({ type: "message", message });
    return message;
  }

  /**
   * Get next message for an agent (peek, doesn't dequeue).
   */
  peek(agentName: string): Message | undefined {
    const queue = this.queues.get(agentName);
    return queue?.[0];
  }

  /**
   * Dequeue and mark as delivered.
   */
  deliver(agentName: string): Message | undefined {
    const queue = this.queues.get(agentName);
    if (!queue || queue.length === 0) return undefined;

    const message = queue.shift()!;
    message.status = "delivered";
    message.deliveredAt = Date.now();
    this.trace.append({ type: "delivery", messageId: message.id, status: "delivered", timestamp: Date.now() });
    return message;
  }

  /**
   * Mark a message as read.
   */
  markRead(messageId: string) {
    const msg = this.allMessages.get(messageId);
    if (msg) {
      msg.status = "read";
      msg.readAt = Date.now();
      this.trace.append({ type: "delivery", messageId, status: "read", timestamp: Date.now() });
    }
  }

  /**
   * Get queue depth for an agent.
   */
  queueDepth(agentName: string): number {
    return this.queues.get(agentName)?.length || 0;
  }

  /**
   * Flush all queued messages for an agent (for manager reconnect).
   */
  flushQueue(agentName: string): Message[] {
    const queue = this.queues.get(agentName) || [];
    const messages = [...queue];
    // Mark all as delivered
    for (const msg of messages) {
      msg.status = "delivered";
      msg.deliveredAt = Date.now();
      this.trace.append({ type: "delivery", messageId: msg.id, status: "delivered", timestamp: Date.now() });
    }
    this.queues.set(agentName, []);
    return messages;
  }

  /**
   * Get thread info.
   */
  getThread(threadId: string): Thread | undefined {
    return this.threads.get(threadId);
  }

  /**
   * Get all messages in a thread.
   */
  getThreadMessages(threadId: string): Message[] {
    return [...this.allMessages.values()]
      .filter((m) => m.threadId === threadId)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get message stats for an agent.
   */
  getStats(agentName: string): { sent: number; received: number; queued: number } {
    let sent = 0, received = 0;
    for (const msg of this.allMessages.values()) {
      if (msg.from === agentName) sent++;
      if (msg.to === agentName) received++;
    }
    return { sent, received, queued: this.queueDepth(agentName) };
  }

  /**
   * Get all threads.
   */
  listThreads(): Thread[] {
    return [...this.threads.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  }
}
