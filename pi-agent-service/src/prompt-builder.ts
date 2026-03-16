/**
 * Prompt builder — assembles agent system prompts per turn.
 *
 * Assembly order (per [gzoe99o0]):
 * 1. Agent's SYSTEM.md (re-read from disk each turn)
 * 2. Coding guidelines (if coding_tools=true)
 * 3. Brief injection ("How Others See You")
 * 4. Address book (ACL-filtered agent list with briefs)
 * 5. Unattended agent instructions (hardcoded)
 *
 * Reference: asset [gzoe99o0]
 */

import * as fs from "fs";
import * as path from "path";
import type { AgentConfig, AclRule } from "./types.js";

const UNATTENDED_INSTRUCTIONS = `
## Operating Mode

You are an UNATTENDED agent. You cannot interact with humans directly.
- Your ONLY communication channel is the message system (send_message tool)
- Work until your task criteria are fully met
- If blocked or unsolvable, send a message to the manager explaining the situation
- Only go idle when ALL your assigned work is complete and no responses are pending
- NEVER wait for human input — you will not receive any
`.trim();

const CODING_GUIDELINES = `
## Coding Guidelines

- Use bash for file operations like ls, rg, find
- Use read to examine files before editing
- Use edit for precise changes (old text must match exactly)
- Use write only for new files or complete rewrites
- Be concise in responses
- Show file paths clearly when working with files
`.trim();

export interface PromptBuilderDeps {
  /** Get agent config by name */
  getAgentConfig: (name: string) => AgentConfig | undefined;
  /** Get all agent configs (for address book) */
  getAllAgentConfigs: () => AgentConfig[];
  /** Get ACL rules */
  getAcl: () => AclRule[];
  /** Resolve agent folder path */
  resolveAgentPath: (agentPath: string) => string;
  /** Get agent folder path from settings.agents[] */
  getAgentPaths: () => string[];
}

/**
 * Build the system prompt for an agent. Called per-turn (re-reads SYSTEM.md).
 */
export function buildSystemPrompt(
  agentName: string,
  deps: PromptBuilderDeps,
): string {
  const config = deps.getAgentConfig(agentName);
  if (!config) {
    return `You are agent "${agentName}". No configuration found.\n\n${UNATTENDED_INSTRUCTIONS}`;
  }

  const sections: string[] = [];

  // 1. SYSTEM.md (re-read from disk)
  const systemMd = readSystemMd(agentName, deps);
  if (systemMd) {
    sections.push(systemMd);
  }

  // 2. Coding guidelines (if coding_tools enabled)
  if (config.coding_tools) {
    sections.push(CODING_GUIDELINES);
  }

  // 3. Brief injection
  sections.push(`## How Others See You\n\nOther agents know this about you: "${config.brief}"`);

  // 4. Address book (ACL-filtered)
  const addressBook = buildAddressBook(agentName, deps);
  if (addressBook) {
    sections.push(addressBook);
  }

  // 5. Unattended instructions
  sections.push(UNATTENDED_INSTRUCTIONS);

  return sections.join("\n\n");
}

/**
 * Build the message overview for session start / context reset.
 * Injected as the first user message, NOT in system prompt.
 */
export function buildMessageOverview(opts: {
  unreadCount: number;
  threads: Array<{ subject: string; with: string; messageCount: number; lastActivity: string }>;
  handoffSummary?: string;
}): string {
  const lines: string[] = ["## 📬 Message Overview"];

  if (opts.unreadCount > 0) {
    lines.push(`- ${opts.unreadCount} unread messages waiting`);
  } else {
    lines.push("- No unread messages");
  }

  if (opts.threads.length > 0) {
    lines.push("- Active threads:");
    for (const t of opts.threads) {
      lines.push(`  - "${t.subject}" with ${t.with} (${t.messageCount} msgs, last: ${t.lastActivity})`);
    }
  }

  if (opts.handoffSummary) {
    lines.push(`\n### Previous Session Handoff\n${opts.handoffSummary}`);
  }

  return lines.join("\n");
}

// ─── Internal ───────────────────────────────────────────────────

function readSystemMd(agentName: string, deps: PromptBuilderDeps): string | null {
  // Find the agent's folder path
  const agentPaths = deps.getAgentPaths();
  for (const ap of agentPaths) {
    const absPath = deps.resolveAgentPath(ap);
    const configPath = path.join(absPath, "agent.json");
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      if (raw.name === agentName) {
        const systemPath = path.join(absPath, "SYSTEM.md");
        try {
          return fs.readFileSync(systemPath, "utf-8").trim();
        } catch {
          return null;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

function buildAddressBook(agentName: string, deps: PromptBuilderDeps): string | null {
  const acl = deps.getAcl();
  const allConfigs = deps.getAllAgentConfigs();

  // Find who this agent can message
  const canMessage: string[] = ["manager"]; // always can message manager
  const rule = acl.find((r) => r.from === agentName);
  if (rule) {
    canMessage.push(...rule.to.filter((t) => t !== "manager"));
  }

  // Also check if manager can message this agent (implicit)
  // Manager is always available

  const lines: string[] = [
    "## Available Agents",
    "",
    "You can message the following agents:",
    "",
  ];

  for (const target of canMessage) {
    if (target === "manager") {
      lines.push("- **manager** — Orchestrates work across agents.");
    } else {
      const config = allConfigs.find((c) => c.name === target);
      const brief = config?.brief ?? "No description available.";
      lines.push(`- **${target}** — ${brief}`);
    }
  }

  lines.push("");
  lines.push("To send a message, use the `send_message` tool with the agent's name.");

  return lines.join("\n");
}
