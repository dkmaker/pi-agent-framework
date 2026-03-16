/**
 * Context Cutoff — monitors context usage and sends reminders.
 *
 * CONTEXT_CUTOFF.md contains role-specific work (commit, review, etc.)
 * Generic steps (message manager, call agent_new_session) are appended automatically.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "fs";

const AGENT_GENERIC_STEPS = `
**Then, before restarting:**
1. **Message the manager** — report what you accomplished and what's next
2. **Call \`agent_new_session\`** with a detailed continuation prompt so the fresh session knows exactly what to do
`;

const MANAGER_GENERIC_STEPS = `
**Then, before restarting:**
1. **Call \`agent_new_session\`** with a detailed continuation prompt including current project state, agent assignments, and what to monitor next
`;

export function registerCutoff(pi: ExtensionAPI, agentDir: string, cutoffPct: number | null, agentName?: string) {
  if (cutoffPct === null) return;
  const isManager = agentName === "manager" || !process.env.AGENT_NAME;

  const hardCutoffPct = cutoffPct + 10;
  let softReminderSent = false;
  let hardReminderSent = false;

  function loadCutoffInstructions(): string {
    let roleSpecific = "Wrap up your current work.";
    const cutoffPath = `${agentDir}/CONTEXT_CUTOFF.md`;
    if (agentDir && existsSync(cutoffPath)) {
      try { roleSpecific = readFileSync(cutoffPath, "utf-8").trim(); } catch { /* fall through */ }
    }
    return roleSpecific + "\n" + (isManager ? MANAGER_GENERIC_STEPS : AGENT_GENERIC_STEPS);
  }

  pi.on("agent_end", async (_event, ctx) => {
    const tokenPct = ctx?.getContextUsage?.()?.percent;
    if (tokenPct === undefined) return;

    const instructions = loadCutoffInstructions();

    if (tokenPct >= hardCutoffPct && !hardReminderSent) {
      hardReminderSent = true;
      pi.sendUserMessage(
        `🛑 **CRITICAL: Context at ${Math.round(tokenPct)}%** — you MUST act NOW.\n\n${instructions}\n\nThis is urgent. Do not start new work. Wrap up immediately.`
      );
    } else if (tokenPct >= cutoffPct && !softReminderSent) {
      softReminderSent = true;
      pi.sendUserMessage(
        `⚠️ **Context at ${Math.round(tokenPct)}%** — approaching limit.\n\n${instructions}\n\nPlease start wrapping up after your current task.`
      );
    } else if (tokenPct >= cutoffPct && softReminderSent && !hardReminderSent) {
      pi.sendUserMessage(
        `⚠️ **Reminder: Context at ${Math.round(tokenPct)}%** — please wrap up.\n\n${instructions}`
      );
    }
  });
}
