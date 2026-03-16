/**
 * TraceWriter — append-only JSONL audit log with query API.
 *
 * All significant events are traced: messages, state transitions, health changes,
 * agent lifecycle, context cutoff, service lifecycle.
 *
 * Reference: asset [f5z68c4v]
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { nanoid } from "nanoid";
import type { TraceEntry, TraceEntryType } from "./types.js";

export interface TraceQueryOpts {
  agent?: string;
  type?: TraceEntryType | TraceEntryType[];
  threadId?: string;
  after?: string; // ISO timestamp
  before?: string; // ISO timestamp
  limit?: number; // default: 50, max: 500
}

export class TraceWriter {
  private fd: number | null = null;

  private constructor(private tracePath: string) {}

  /**
   * Create and initialize a TraceWriter.
   * Creates the file if it doesn't exist.
   */
  static async create(tracePath: string): Promise<TraceWriter> {
    const writer = new TraceWriter(tracePath);
    await writer.init();
    return writer;
  }

  private async init(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.tracePath), { recursive: true });
    // Open in append mode — creates if missing
    this.fd = fs.openSync(this.tracePath, "a");
  }

  /**
   * Append a trace entry. Assigns id and timestamp automatically.
   * Returns the completed entry.
   */
  append(fields: { type: TraceEntryType; [key: string]: unknown }): TraceEntry {
    const entry: TraceEntry = {
      id: nanoid(),
      ts: new Date().toISOString(),
      ...fields,
    };

    const line = `${JSON.stringify(entry)}\n`;
    if (this.fd !== null) {
      fs.writeSync(this.fd, line);
    }

    return entry;
  }

  /**
   * Query trace entries. Sequential scan from end of file.
   * MVP implementation — no index.
   */
  query(opts: TraceQueryOpts = {}): TraceEntry[] {
    const limit = Math.min(opts.limit ?? 50, 500);
    const types = opts.type ? (Array.isArray(opts.type) ? opts.type : [opts.type]) : undefined;

    // Read all lines
    let content: string;
    try {
      content = fs.readFileSync(this.tracePath, "utf-8");
    } catch {
      return [];
    }

    const lines = content.trim().split("\n").filter(Boolean);
    const results: TraceEntry[] = [];

    // Scan from end for efficiency (most queries want recent entries)
    for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
      let entry: TraceEntry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue; // skip corrupt lines
      }

      // Apply filters
      if (types && !types.includes(entry.type)) continue;
      if (opts.agent && (entry as any).agent !== opts.agent) continue;
      if (opts.threadId && (entry as any).threadId !== opts.threadId) continue;
      if (opts.after && entry.ts <= opts.after) continue;
      if (opts.before && entry.ts >= opts.before) continue;

      results.push(entry);
    }

    // Results are in reverse chronological — reverse to chronological
    return results.reverse();
  }

  /**
   * Read all entries (for state recovery).
   */
  readAll(): TraceEntry[] {
    let content: string;
    try {
      content = fs.readFileSync(this.tracePath, "utf-8");
    } catch {
      return [];
    }

    const entries: TraceEntry[] = [];
    for (const line of content.trim().split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip corrupt lines
      }
    }
    return entries;
  }

  /**
   * Close the file descriptor.
   */
  dispose(): void {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }
}
