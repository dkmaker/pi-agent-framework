/**
 * Agent Messaging — filesystem-based inbox/outbox between agents.
 *
 * Startup: does NOT auto-inject pre-existing messages. Injects summary
 * so agent can decide to read them. Only NEW messages auto-inject.
 * Threads tracked in threads.json with loop protection at MAX_THREAD_MESSAGES.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import {
  existsSync, mkdirSync, readdirSync,
  readFileSync, writeFileSync, renameSync,
} from "fs";
import { join } from "path";
import { ThreadTracker, MAX_THREAD_MESSAGES } from "./threads";
import { loadAgentACL } from "./acl";

export interface ParsedMessage {
  from: string;
  to: string;
  type: "steer" | "followup";
  timestamp: string;
  subject: string;
  thread_id: string;
  body: string;
  filename: string;
}

export function parseMessage(content: string, filename: string): ParsedMessage | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  return {
    from: fm.from || "unknown",
    to: fm.to || "unknown",
    type: (fm.type === "steer" ? "steer" : "followup"),
    timestamp: fm.timestamp || new Date().toISOString(),
    subject: fm.subject || "No subject",
    thread_id: fm.thread_id || "",
    body: match[2].trim(),
    filename,
  };
}

function readMessagesFromDir(dir: string): ParsedMessage[] {
  if (!existsSync(dir)) return [];
  const messages: ParsedMessage[] = [];
  try {
    for (const file of readdirSync(dir).filter(f => f.endsWith(".md")).sort()) {
      try {
        const msg = parseMessage(readFileSync(join(dir, file), "utf-8"), file);
        if (msg) messages.push(msg);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return messages;
}

export function registerMessaging(pi: ExtensionAPI, agentName: string, agentsDir: string) {
  const mailboxDir = join(agentsDir, "mailbox");
  const inboxDir = join(mailboxDir, agentName, "inbox");
  const archiveDir = join(mailboxDir, agentName, "archive");

  mkdirSync(inboxDir, { recursive: true });
  mkdirSync(archiveDir, { recursive: true });

  const acl = loadAgentACL(agentsDir, agentName);
  const sendTo = acl.send_to;
  const receiveFrom = acl.receive_from;
  const threads = new ThreadTracker(mailboxDir);

  // Track files at startup — don't auto-inject these
  const startupFiles = new Set(readdirSync(inboxDir).filter(f => f.endsWith(".md")));
  let startupNotified = false;

  // ── Archive helper ──────────────────────────────────────────────────

  function archiveMessage(msg: ParsedMessage) {
    try {
      renameSync(join(inboxDir, msg.filename), join(archiveDir, msg.filename));
      if (msg.thread_id) {
        threads.moveMessage(msg.thread_id, msg.filename, `${agentName}/archive`);
      }
    } catch { /* already moved */ }
    startupFiles.delete(msg.filename);
  }

  // ── Auto-inject NEW messages only ───────────────────────────────────

  function processNewMessages() {
    let files: string[];
    try { files = readdirSync(inboxDir).filter(f => f.endsWith(".md")).sort(); } catch { return; }

    for (const file of files) {
      if (startupFiles.has(file)) continue;

      try {
        const content = readFileSync(join(inboxDir, file), "utf-8");
        const msg = parseMessage(content, file);
        if (!msg || !receiveFrom.includes(msg.from)) continue;

        const time = msg.timestamp.replace("T", " ").replace(/\.\d+Z$/, "");
        const threadLine = msg.thread_id ? `\n**Thread:** ${msg.thread_id}` : "";
        const replyHint = msg.thread_id
          ? `*Reply with \`agent_send_message\` to "${msg.from}", thread_id: "${msg.thread_id}"*`
          : `*Reply with \`agent_send_message\` to "${msg.from}"*`;
        const injected = `📨 From: ${msg.from} | Subject: ${msg.subject}${threadLine}\n\n${msg.body}\n\n---\n${replyHint}`;

        if (msg.type === "steer") {
          pi.sendMessage({ customType: "inbound-message", role: "user", content: injected, display: true }, { deliverAs: "steer", triggerTurn: true });
        } else {
          pi.sendMessage({ customType: "inbound-message", role: "user", content: injected, display: true }, { deliverAs: "followUp", triggerTurn: true });
        }

        archiveMessage(msg);
      } catch { /* skip */ }
    }
  }

  // Notify about pre-existing unread on first turn
  pi.on("before_agent_start", async (event) => {
    if (startupNotified) return {};
    startupNotified = true;

    const unread = readMessagesFromDir(inboxDir).filter(m => receiveFrom.includes(m.from));
    if (unread.length === 0) return {};

    const summary = unread.map((m, i) => {
      const thread = m.thread_id ? ` [thread: ${m.thread_id}]` : "";
      return `- [${i}] **${m.subject}** from ${m.from}${thread}`;
    }).join("\n");

    const notice = `\n\n## 📬 Unread Messages (${unread.length})\n\n${summary}\n\nUse \`agent_read_message\` with the index to read. Ignore if stale.`;
    return { systemPrompt: event.systemPrompt + notice };
  });

  pi.on("agent_end", async () => processNewMessages());

  // Poll inbox every second
  const pollInterval = setInterval(() => processNewMessages(), 1000);
  pi.on("session_shutdown", async () => clearInterval(pollInterval));

  // ── Send Message ────────────────────────────────────────────────────

  const sendToEnum = sendTo.length > 0 ? sendTo : ["none"];

  pi.registerTool({
    name: "agent_send_message",
    label: "Send Message",
    description:
      "Send a message to another agent. Subject MUST be a short AI-optimized topic (5-10 words). " +
      "Use thread_id to continue a thread. Omit for new thread. " +
      "AVOID marking as important unless the matter is truly time-sensitive and requires immediate interruption.",
    parameters: Type.Object({
      to: StringEnum(sendToEnum as [string, ...string[]]),
      subject: Type.String({ description: "Short AI-optimized topic (5-10 words)" }),
      body: Type.String({ description: "Message content (markdown)" }),
      important: Type.Optional(Type.Boolean({ description: "Mark as important — interrupts the recipient immediately. Only for time-bound urgent matters. Default: false" })),
      thread_id: Type.Optional(Type.String({ description: "Thread ID to continue. Omit for new thread." })),
    }),
    async execute(_toolCallId, params) {
      const { to, subject, body, important, thread_id } = params as {
        to: string; subject: string; body: string; important?: boolean; thread_id?: string;
      };
      const type = important ? "steer" : "followup";

      if (!sendTo.includes(to)) {
        return { content: [{ type: "text", text: `Cannot send to "${to}". Allowed: ${sendTo.join(", ")}` }], isError: true };
      }

      const threadId = thread_id || `${agentName}-${Date.now()}`;

      // Thread loop protection
      if (threads.isThreadExhausted(threadId)) {
        const count = threads.getThreadCount(threadId);
        return { content: [{ type: "text", text: `🛑 Thread "${threadId}" has ${count} messages (limit: ${MAX_THREAD_MESSAGES}). Start a new thread or escalate.` }], isError: true };
      }

      const label = important ? "🚨 important" : "message";
      const targetInbox = join(mailboxDir, to, "inbox");
      mkdirSync(targetInbox, { recursive: true });

      const timestamp = new Date().toISOString();
      const safeTs = timestamp.replace(/[:.]/g, "-");
      const filename = `${safeTs}_${agentName}.md`;

      const message = `---
from: ${agentName}
to: ${to}
type: ${type}
timestamp: ${timestamp}
subject: ${subject}
thread_id: ${threadId}
---

${body}
`;
      writeFileSync(join(targetInbox, filename), message);
      threads.recordMessage(threadId, subject, agentName, to, filename, `${to}/inbox`, timestamp);

      const threadCount = threads.getThreadCount(threadId);
      return { content: [{ type: "text", text: `📤 To: ${to} | Subject: ${subject} [thread: ${threadId}, #${threadCount}]` }] };
    },
  });

  // ── Read Message (archives on read) ─────────────────────────────────

  pi.registerTool({
    name: "agent_read_message",
    label: "Read Message",
    description: "Read an unread message by index (0 = oldest). Archives it after reading.",
    parameters: Type.Object({
      index: Type.Number({ description: "Message index (0 = oldest unread)" }),
    }),
    async execute(_toolCallId, params) {
      const { index } = params as { index: number };
      const messages = readMessagesFromDir(inboxDir).filter(m => receiveFrom.includes(m.from));

      if (index < 0 || index >= messages.length) {
        return { content: [{ type: "text", text: `No message at index ${index}. ${messages.length} unread.` }], isError: true };
      }

      const msg = messages[index];
      archiveMessage(msg);

      const thread = msg.thread_id ? `\n**Thread:** ${msg.thread_id} (${threads.getThreadCount(msg.thread_id)} msgs)` : "";
      const replyHint = msg.thread_id
        ? `*Reply with \`agent_send_message\` to "${msg.from}", thread_id: "${msg.thread_id}"*`
        : `*Reply with \`agent_send_message\` to "${msg.from}"*`;

      return { content: [{ type: "text", text: `## 📨 From ${msg.from}\n**Subject:** ${msg.subject}\n**Time:** ${msg.timestamp}${thread}\n\n${msg.body}\n\n---\n${replyHint}` }] };
    },
  });

  // ── List Messages (no side effects) ─────────────────────────────────

  pi.registerTool({
    name: "agent_list_messages",
    label: "List Messages",
    description: "List unread inbox + recent archive. Does NOT archive anything.",
    parameters: Type.Object({
      count: Type.Optional(Type.Number({ description: "Total to show (default: 10)" })),
      thread_id: Type.Optional(Type.String({ description: "Filter by thread ID" })),
    }),
    async execute(_toolCallId, params) {
      const { count = 10, thread_id } = params as { count?: number; thread_id?: string };

      const inbox = readMessagesFromDir(inboxDir).filter(m => receiveFrom.includes(m.from));
      const archive = readMessagesFromDir(archiveDir).reverse().slice(0, count);

      let all = [
        ...inbox.map((m, i) => ({ ...m, label: `📬 unread [${i}]` })),
        ...archive.map(m => ({ ...m, label: "📭 read" })),
      ];

      if (thread_id) all = all.filter(m => m.thread_id === thread_id);
      all = all.slice(0, count);

      if (all.length === 0) return { content: [{ type: "text", text: "No messages." }] };

      const lines = all.map(m => {
        const thread = m.thread_id ? ` [${m.thread_id}]` : "";
        const time = m.timestamp.replace("T", " ").replace(/\.\d+Z$/, "");
        return `${m.label} **${m.subject}** from ${m.from} (${time})${thread}`;
      });

      return { content: [{ type: "text", text: `## Messages (${inbox.length} unread)\n\n${lines.join("\n")}` }] };
    },
  });

  // ── List Agents ─────────────────────────────────────────────────────

  pi.registerTool({
    name: "agent_list_agents",
    label: "List Agents",
    description: "List agents you can communicate with and their briefs.",
    parameters: Type.Object({}),
    async execute() {
      const lines = sendTo.map(name => {
        const config = loadAgentACL(agentsDir, name);
        const canTalkTo = config.send_to.length > 0 ? config.send_to.join(", ") : "nobody";
        return `**${name}** — ${config.brief}\n  _Can talk to: ${canTalkTo}_`;
      });
      if (lines.length === 0) lines.push("No agents configured.");
      return { content: [{ type: "text", text: `## Available Agents\n\n${lines.join("\n\n")}` }] };
    },
  });

  return { sendTo, receiveFrom };
}
