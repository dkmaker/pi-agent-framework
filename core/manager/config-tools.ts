/**
 * Manager Config Tools — read and update agent configurations without manual file editing.
 *
 * Tools for managing: agent.json, SYSTEM.md, AGENTS.md, CONTEXT_CUTOFF.md,
 * FINDINGS.md, MONITOR.md, acl.json, manager.json
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

// Files that can be read/written per agent
const AGENT_FILES = ["agent.json", "SYSTEM.md", "AGENTS.md", "CONTEXT_CUTOFF.md"] as const;
// Files for manager specifically
const MANAGER_FILES = ["manager.json", "SYSTEM.md", "AGENTS.md", "CONTEXT_CUTOFF.md", "MONITOR.md", "FINDINGS.md"] as const;
// Shared files
const SHARED_FILES = ["CONVENTIONS.md"] as const;

function discoverAgents(agentsDir: string): string[] {
  const agents: string[] = [];
  try {
    for (const dir of readdirSync(agentsDir)) {
      if (existsSync(join(agentsDir, dir, "agent.json"))) {
        agents.push(dir);
      }
    }
  } catch { /* skip */ }
  return agents;
}

function getAgentDir(agentsDir: string, name: string): string {
  if (name === "manager") return join(agentsDir, "manager");
  if (name === "shared") return join(agentsDir, "shared");
  return join(agentsDir, name);
}

export function registerConfigTools(pi: ExtensionAPI, agentsDir: string) {
  const allAgents = [...discoverAgents(agentsDir), "manager", "shared"];
  const agentEnum = allAgents as [string, ...string[]];

  // ── Dump full agent config ──────────────────────────────────────────

  pi.registerTool({
    name: "agent_config_dump",
    label: "Dump Agent Config",
    description: "Show full configuration for an agent — all config files, system prompt, instructions, cutoff, and ACL entry.",
    parameters: Type.Object({
      agent: StringEnum(agentEnum, { description: "Agent name" }),
    }),
    async execute(_toolCallId, params) {
      const { agent } = params as { agent: string };
      const dir = getAgentDir(agentsDir, agent);
      const sections: string[] = [`# Agent Config: ${agent}\n`];

      // ACL entry
      const aclPath = join(agentsDir, "acl.json");
      if (existsSync(aclPath)) {
        try {
          const acl = JSON.parse(readFileSync(aclPath, "utf-8"));
          if (acl[agent]) {
            sections.push(`## ACL\n\`\`\`json\n${JSON.stringify(acl[agent], null, 2)}\n\`\`\`\n`);
          }
        } catch { /* skip */ }
      }

      // All config files
      const files = agent === "shared" ? SHARED_FILES : agent === "manager" ? MANAGER_FILES : AGENT_FILES;
      for (const file of files) {
        const filePath = join(dir, file);
        if (existsSync(filePath)) {
          try {
            const content = readFileSync(filePath, "utf-8").trim();
            const ext = file.endsWith(".json") ? "json" : "markdown";
            sections.push(`## ${file}\n\`\`\`${ext}\n${content}\n\`\`\`\n`);
          } catch { /* skip */ }
        }
      }

      return { content: [{ type: "text", text: sections.join("\n") }] };
    },
  });

  // ── Read a specific config file ─────────────────────────────────────

  pi.registerTool({
    name: "agent_config_get",
    label: "Get Agent Config File",
    description: "Read a specific config file for an agent.",
    parameters: Type.Object({
      agent: StringEnum(agentEnum, { description: "Agent name" }),
      file: Type.String({ description: "File name: agent.json, SYSTEM.md, AGENTS.md, CONTEXT_CUTOFF.md, MONITOR.md, FINDINGS.md, manager.json" }),
    }),
    async execute(_toolCallId, params) {
      const { agent, file } = params as { agent: string; file: string };
      const filePath = join(getAgentDir(agentsDir, agent), file);

      if (!existsSync(filePath)) {
        return { content: [{ type: "text", text: `File not found: ${agent}/${file}` }], isError: true };
      }

      try {
        const content = readFileSync(filePath, "utf-8");
        return { content: [{ type: "text", text: `## ${agent}/${file}\n\n${content}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error reading ${agent}/${file}: ${e}` }], isError: true };
      }
    },
  });

  // ── Update a specific config file ───────────────────────────────────

  pi.registerTool({
    name: "agent_config_set",
    label: "Update Agent Config File",
    description: "Write new content to a specific agent config file. Overwrites the entire file.",
    parameters: Type.Object({
      agent: StringEnum(agentEnum, { description: "Agent name" }),
      file: Type.String({ description: "File name: agent.json, SYSTEM.md, AGENTS.md, CONTEXT_CUTOFF.md, MONITOR.md, FINDINGS.md, manager.json" }),
      content: Type.String({ description: "New file content (full replacement)" }),
    }),
    async execute(_toolCallId, params) {
      const { agent, file, content } = params as { agent: string; file: string; content: string };
      const dir = getAgentDir(agentsDir, agent);
      const filePath = join(dir, file);

      // Safety: only allow known config files
      const allowed = [...AGENT_FILES, ...MANAGER_FILES, ...SHARED_FILES];
      if (!allowed.includes(file as any)) {
        return { content: [{ type: "text", text: `Not allowed to write: ${file}. Allowed: ${allowed.join(", ")}` }], isError: true };
      }

      try {
        writeFileSync(filePath, content);
        return { content: [{ type: "text", text: `✅ Updated ${agent}/${file}` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error writing ${agent}/${file}: ${e}` }], isError: true };
      }
    },
  });

  // ── Get ACL ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: "agent_acl_get",
    label: "Get ACL",
    description: "Show the full agent ACL (who can talk to who).",
    parameters: Type.Object({}),
    async execute() {
      const aclPath = join(agentsDir, "acl.json");
      if (!existsSync(aclPath)) {
        return { content: [{ type: "text", text: "No acl.json found." }], isError: true };
      }
      try {
        const content = readFileSync(aclPath, "utf-8");
        return { content: [{ type: "text", text: `## ACL\n\`\`\`json\n${content}\`\`\`` }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e}` }], isError: true };
      }
    },
  });

  // ── Update ACL ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "agent_acl_set",
    label: "Update ACL",
    description: "Update the full ACL config (acl.json). Provide the complete JSON.",
    parameters: Type.Object({
      content: Type.String({ description: "Full acl.json content (JSON)" }),
    }),
    async execute(_toolCallId, params) {
      const { content } = params as { content: string };
      const aclPath = join(agentsDir, "acl.json");

      // Validate JSON
      try {
        JSON.parse(content);
      } catch {
        return { content: [{ type: "text", text: "Invalid JSON." }], isError: true };
      }

      try {
        writeFileSync(aclPath, content);
        return { content: [{ type: "text", text: "✅ ACL updated. Agents need /reload to pick up changes." }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e}` }], isError: true };
      }
    },
  });
}
