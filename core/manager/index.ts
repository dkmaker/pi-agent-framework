/**
 * Manager Extension — messaging, monitoring, and context cutoff for the manager session.
 *
 * Sits alongside the agent modules but is NOT loaded by agent/index.ts.
 * Loaded via .pi/extensions/manager.ts re-export.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { registerMessaging } from "../shared/messaging";
import { loadAgentACL } from "../shared/acl";
import { registerMonitor } from "./monitor";
import { registerConfigTools } from "./config-tools";
import { registerTools } from "../agent/tools";

export default function (pi: ExtensionAPI) {
  // Skip if running as a managed agent (agent/index.ts handles it)
  if (process.env.AGENT_NAME) return;

  const managerDir = resolve(__dirname);
  const agentsDir = resolve(__dirname, "..");
  const aclPath = join(agentsDir, "acl.json");
  if (!existsSync(aclPath)) return;

  const agentName = "manager";
  process.env.AGENTS_DIR = process.env.AGENTS_DIR || agentsDir;

  // ── Messaging ───────────────────────────────────────────────────────
  const { sendTo } = registerMessaging(pi, agentName, agentsDir);

  // ── Session tools (new session, reload) ──────────────────────────────
  registerTools(pi);

  // ── Config management tools ─────────────────────────────────────────
  registerConfigTools(pi, agentsDir);

  // ── Monitor loop ────────────────────────────────────────────────────
  const configPath = join(managerDir, "manager.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      const monitorConfig = config.monitor || { interval_seconds: 60, max_turns: 50 };
      registerMonitor(pi, managerDir, monitorConfig);

      // ── Context cutoff ────────────────────────────────────────────
      const cutoffPct = config.context_cutoff_pct;
      if (cutoffPct) {
        const { registerCutoff } = require("../agent/cutoff");
        registerCutoff(pi, managerDir, cutoffPct);
      }
    } catch { /* bad config, skip */ }
  }

  // ── System prompt injection ─────────────────────────────────────────
  pi.on("before_agent_start", async (event) => {
    const ownACL = loadAgentACL(agentsDir, agentName);
    const lines = sendTo.map(name => {
      const acl = loadAgentACL(agentsDir, name);
      return `- **${name}** — ${acl.brief}`;
    });

    // Load SYSTEM.md
    let systemMd = "";
    const systemPath = join(managerDir, "SYSTEM.md");
    if (existsSync(systemPath)) {
      try { systemMd = "\n\n" + readFileSync(systemPath, "utf-8").trim(); } catch { /* skip */ }
    }

    // Load AGENTS.md (mutable learnings)
    let agentsMd = "";
    const agentsPath = join(managerDir, "AGENTS.md");
    if (existsSync(agentsPath)) {
      try { agentsMd = "\n\n" + readFileSync(agentsPath, "utf-8").trim(); } catch { /* skip */ }
    }

    const notice = `${systemMd}

## Your Identity

You are **${agentName}**. Other agents know this about you:
> ${ownACL.brief}

## Agent Directory

You can send messages to these agents using \`agent_send_message\`:
${lines.join("\n")}

Use \`agent_list_agents\` to see this list. Use \`agent_list_messages\` to check inbox/archive.
Use \`agent_read_message\` to read unread messages by index.
Mark messages as \`important: true\` only for time-bound urgent matters.

## Self-Updating Instructions

Your mutable instructions are at: ${managerDir}/AGENTS.md
- Read with the read tool to review current instructions
- Update with the edit tool when you learn something important
${agentsMd}`;

    return { systemPrompt: event.systemPrompt + notice };
  });
}
