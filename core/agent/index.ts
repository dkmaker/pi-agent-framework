/**
 * Agent Extension — entry point.
 *
 * Lightweight extension for managed pi agent instances.
 * Features: relay status, context cutoff, self-management tools,
 * prompt injection, inter-agent messaging.
 *
 * Env vars:
 *   AGENT_NAME         — agent identifier (e.g. "worker")
 *   PI_RELAY_ID        — relay status file ID (defaults to AGENT_NAME)
 *   AGENT_DIR          — path to agent config dir
 *   AGENTS_DIR         — path to .pi/agents/ root (for messaging/configs)
 *   CONTEXT_CUTOFF_PCT — context % threshold for soft reminder
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerRelay } from "./relay";
import { registerCutoff } from "./cutoff";
import { registerTools } from "./tools";
import { registerPromptInjection } from "./prompt";
import { registerMessaging } from "../shared/messaging";

export default function (pi: ExtensionAPI) {
  const agentName = process.env.AGENT_NAME;
  if (!agentName) return;

  const relayId = process.env.PI_RELAY_ID || agentName;
  const agentDir = process.env.AGENT_DIR || "";
  const agentsDir = process.env.AGENTS_DIR || "";
  const cutoffEnv = process.env.CONTEXT_CUTOFF_PCT;
  const cutoffPct = cutoffEnv ? parseInt(cutoffEnv, 10) : null;

  registerRelay(pi, agentName, relayId);
  registerCutoff(pi, agentDir, cutoffPct);
  registerTools(pi);

  let sendTo: string[] = [];
  if (agentsDir) {
    const messaging = registerMessaging(pi, agentName, agentsDir);
    sendTo = messaging.sendTo;
  }

  registerPromptInjection(pi, agentName, agentDir, cutoffPct, sendTo, agentsDir);
}
