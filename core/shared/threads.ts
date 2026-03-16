/**
 * Thread Tracker — manages thread state via threads.json in the mailbox.
 *
 * Uses a lockfile to prevent race conditions between agents writing
 * simultaneously. Each read/write operation acquires the lock, reads
 * fresh state from disk, mutates, writes back, and releases.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync } from "fs";
import { join } from "path";

export const MAX_THREAD_MESSAGES = 100;

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;

export interface ThreadMessage {
  filename: string;
  from: string;
  to: string;
  timestamp: string;
  location: string;
}

export interface Thread {
  id: string;
  count: number;
  subject: string;
  participants: string[];
  messages: ThreadMessage[];
  created: string;
  updated: string;
}

interface ThreadsState {
  threads: Record<string, Thread>;
}

function acquireLock(lockPath: string): boolean {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      // O_CREAT | O_EXCL — fails if file already exists (atomic)
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      return true;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        // Check if lock is stale (older than timeout)
        try {
          const stat = readFileSync(lockPath, "utf-8");
          const lockTime = parseInt(stat, 10);
          if (Date.now() - lockTime > LOCK_TIMEOUT_MS) {
            // Stale lock — remove and retry
            try { unlinkSync(lockPath); } catch { /* race with another cleaner */ }
            continue;
          }
        } catch { /* can't read lock, try again */ }

        // Wait and retry
        const waitUntil = Date.now() + LOCK_RETRY_MS;
        while (Date.now() < waitUntil) { /* spin */ }
        continue;
      }
      return false;
    }
  }
  return false;
}

function releaseLock(lockPath: string) {
  try { unlinkSync(lockPath); } catch { /* already released */ }
}

export class ThreadTracker {
  private filePath: string;
  private lockPath: string;

  constructor(mailboxDir: string) {
    this.filePath = join(mailboxDir, "threads.json");
    this.lockPath = join(mailboxDir, "threads.lock");
    mkdirSync(mailboxDir, { recursive: true });
  }

  /** Read fresh state from disk (must hold lock) */
  private readState(): ThreadsState {
    if (existsSync(this.filePath)) {
      try { return JSON.parse(readFileSync(this.filePath, "utf-8")); } catch { /* corrupted */ }
    }
    return { threads: {} };
  }

  /** Write state to disk (must hold lock) */
  private writeState(state: ThreadsState) {
    try {
      writeFileSync(this.filePath, JSON.stringify(state, null, 2));
    } catch { /* ignore */ }
  }

  /** Execute a callback with lock held, fresh state read, and auto-save */
  private withLock<T>(fn: (state: ThreadsState) => T): T {
    // Write timestamp to lock for stale detection
    const locked = acquireLock(this.lockPath);
    if (locked) {
      try { writeFileSync(this.lockPath, String(Date.now())); } catch { /* ok */ }
    }

    try {
      const state = this.readState();
      const result = fn(state);
      this.writeState(state);
      return result;
    } finally {
      if (locked) releaseLock(this.lockPath);
    }
  }

  /** Read-only access with lock (no save) */
  private withLockRead<T>(fn: (state: ThreadsState) => T): T {
    const locked = acquireLock(this.lockPath);
    try {
      return fn(this.readState());
    } finally {
      if (locked) releaseLock(this.lockPath);
    }
  }

  getThread(threadId: string): Thread | undefined {
    return this.withLockRead(state => state.threads[threadId]);
  }

  isThreadExhausted(threadId: string): boolean {
    return this.withLockRead(state => {
      const thread = state.threads[threadId];
      return thread ? thread.count >= MAX_THREAD_MESSAGES : false;
    });
  }

  getThreadCount(threadId: string): number {
    return this.withLockRead(state => state.threads[threadId]?.count || 0);
  }

  recordMessage(
    threadId: string, subject: string, from: string, to: string,
    filename: string, location: string, timestamp: string,
  ) {
    this.withLock(state => {
      if (!state.threads[threadId]) {
        state.threads[threadId] = {
          id: threadId, count: 0, subject,
          participants: [], messages: [],
          created: timestamp, updated: timestamp,
        };
      }

      const thread = state.threads[threadId];
      thread.count++;
      thread.updated = timestamp;
      if (!thread.participants.includes(from)) thread.participants.push(from);
      if (!thread.participants.includes(to)) thread.participants.push(to);
      thread.messages.push({ filename, from, to, timestamp, location });
    });
  }

  moveMessage(threadId: string, filename: string, newLocation: string) {
    this.withLock(state => {
      const thread = state.threads[threadId];
      if (!thread) return;
      const msg = thread.messages.find(m => m.filename === filename);
      if (msg) msg.location = newLocation;
    });
  }

  listThreads(count = 10): Thread[] {
    return this.withLockRead(state =>
      Object.values(state.threads)
        .sort((a, b) => b.updated.localeCompare(a.updated))
        .slice(0, count)
    );
  }
}
