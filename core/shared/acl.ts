/**
 * Agent ACL — loads permissions from central .pi/agents/acl.json
 *
 * Single file controls all agent communication permissions and briefs.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

export interface AgentACL {
  send_to: string[];
  receive_from: string[];
  brief: string;
}

const EMPTY_ACL: AgentACL = { send_to: [], receive_from: [], brief: "No brief available." };

let cachedPath: string | null = null;
let cachedData: Record<string, AgentACL> | null = null;
let cachedMtime = 0;

function loadACLFile(agentsDir: string): Record<string, AgentACL> {
  const aclPath = join(agentsDir, "acl.json");

  // Re-read if file changed (check mtime)
  try {
    const { mtimeMs } = require("fs").statSync(aclPath);
    if (cachedPath === aclPath && cachedData && cachedMtime === mtimeMs) {
      return cachedData;
    }
    cachedMtime = mtimeMs;
  } catch { return {}; }

  if (!existsSync(aclPath)) return {};
  try {
    const data = JSON.parse(readFileSync(aclPath, "utf-8"));
    cachedPath = aclPath;
    cachedData = data;
    return data;
  } catch { return {}; }
}

export function loadAgentACL(agentsDir: string, name: string): AgentACL {
  const all = loadACLFile(agentsDir);
  const entry = all[name];
  if (!entry) return EMPTY_ACL;
  return {
    send_to: entry.send_to || [],
    receive_from: entry.receive_from || [],
    brief: entry.brief || "No brief available.",
  };
}

export function listAllAgents(agentsDir: string): { name: string; brief: string }[] {
  const all = loadACLFile(agentsDir);
  return Object.entries(all).map(([name, acl]) => ({
    name,
    brief: acl.brief || "No brief available.",
  }));
}
