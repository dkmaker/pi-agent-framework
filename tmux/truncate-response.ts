/**
 * Shared tool response truncation utility.
 *
 * Prevents tool responses from blowing up the context window.
 * When truncated, saves full output to /tmp and appends a notice.
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/** Default max characters (~7.5K tokens). */
const DEFAULT_MAX_CHARS = 30_000;

export interface TruncateOptions {
  /** Max characters (default: 30000). */
  maxChars?: number;
  /** Tool name for the dump filename. */
  toolName?: string;
}

/**
 * Truncate a tool response text if it exceeds the limit.
 * Saves the full output to /tmp when truncated.
 */
export function truncateToolResponse(
  text: string,
  opts?: TruncateOptions
): string {
  const max = opts?.maxChars ?? DEFAULT_MAX_CHARS;
  if (text.length <= max) return text;

  const toolName = opts?.toolName ?? "tool";
  const dumpPath = join(
    tmpdir(),
    `pi-dev-full-${toolName}-${Date.now()}.txt`
  );
  writeFileSync(dumpPath, text, "utf-8");

  const truncated = text.slice(0, max);
  // Cut at last newline to avoid mid-line truncation
  const lastNewline = truncated.lastIndexOf("\n");
  const clean = lastNewline > max * 0.8 ? truncated.slice(0, lastNewline) : truncated;

  return (
    clean +
    `\n\n⚠️ Response truncated (${text.length} → ${clean.length} chars). Full output: \`${dumpPath}\``
  );
}
