/**
 * Trace — append-only JSONL audit log.
 * Everything is traced. Replayable for state recovery.
 */

import { appendFileSync, readFileSync, existsSync } from "fs";
import type { TraceEntry } from "./types.js";

export class Trace {
  constructor(private filePath: string) {}

  append(entry: TraceEntry) {
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n");
  }

  replay(): TraceEntry[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  query(filter: { type?: string; agent?: string; after?: number; limit?: number }): TraceEntry[] {
    let entries = this.replay();
    if (filter.type) entries = entries.filter((e) => e.type === filter.type);
    if (filter.agent) {
      entries = entries.filter((e) => {
        if ("agent" in e) return (e as any).agent === filter.agent;
        if ("name" in e) return (e as any).name === filter.agent;
        if (e.type === "message") return e.message.from === filter.agent || e.message.to === filter.agent;
        return false;
      });
    }
    if (filter.after) entries = entries.filter((e) => ("timestamp" in e ? (e as any).timestamp : 0) > filter.after!);
    if (filter.limit) entries = entries.slice(-filter.limit);
    return entries;
  }
}
