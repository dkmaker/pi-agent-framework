/**
 * System prompt injection — agent extension injects shared conventions + agent-specific docs.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { loadAgentACL } from "../shared/acl";

export function registerPromptInjection(
  pi: ExtensionAPI,
  agentName: string,
  agentDir: string,
  cutoffPct: number | null,
  sendTo: string[],
  agentsDir: string,
) {
  pi.on("before_agent_start", async (event) => {
    // Identity
    const ownACL = agentsDir ? loadAgentACL(agentsDir, agentName) : null;
    const identity = ownACL
      ? `\n\n## Your Identity\n\nYou are **${agentName}**. Other agents know this about you:\n> ${ownACL.brief}\n`
      : "";

    // Agent directory
    let agentDirectory = "";
    if (sendTo.length > 0 && agentsDir) {
      const entries = sendTo.map(name => {
        const acl = loadAgentACL(agentsDir, name);
        return `- **${name}** — ${acl.brief}`;
      });
      agentDirectory = `
## Agent Directory

You can send messages to these agents using \`agent_send_message\`:
${entries.join("\n")}

Use \`agent_list_agents\` to see this list anytime.
Mark messages as \`important: true\` only for time-bound urgent matters.
`;
    }

    // Load shared conventions from file
    let sharedConventions = "";
    if (agentsDir) {
      const convPath = join(agentsDir, "shared", "CONVENTIONS.md");
      if (existsSync(convPath)) {
        try { sharedConventions = "\n" + readFileSync(convPath, "utf-8").trim() + "\n"; } catch { /* skip */ }
      }
    }

    const sessionManagement = `
## Agent Session Management

You have special tools for managing your own session:
- **\`agent_new_session\`** — starts a fresh session with a continuation prompt. Use when context is high or after completing a batch of work.
- **\`agent_reload\`** — reloads your extensions and config. Use after editing your AGENTS.md.

## Self-Updating Instructions

Your mutable instructions are at: ${agentDir}/AGENTS.md
- Read with the read tool to review current instructions
- Update with the edit tool when you learn something important
- Call \`agent_reload\` to apply changes

## Context Awareness

${cutoffPct !== null
  ? `Your context cutoff is set to ${cutoffPct}%. When you approach this limit, you'll receive reminders. Follow them — commit your work, close/update issues, then call \`agent_new_session\` with a continuation prompt.`
  : "No context cutoff configured. Monitor your context usage and restart when needed."}
`;

    return { systemPrompt: event.systemPrompt + sharedConventions + sessionManagement + identity + agentDirectory };
  });
}
