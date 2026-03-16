/**
 * Spike: Agent with web-search extension loaded via SDK.
 * Alice asks Bob a question. Bob has web_search tool from the extension and looks it up.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createEventBus,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

// --- Mailbox ---
const MAILBOX_DIR = join(import.meta.dirname, "mailbox-ws");
const mkMailbox = (name: string) => {
  const dir = join(MAILBOX_DIR, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const mailboxes: Record<string, string> = { alice: mkMailbox("alice"), bob: mkMailbox("bob") };

function sendMessage(to: string, from: string, content: string): string {
  const filename = `${Date.now()}-from-${from}.md`;
  writeFileSync(join(mailboxes[to], filename), content);
  console.log(`  📤 ${from} → ${to}: ${content.substring(0, 80)}...`);
  return `Message sent to ${to}`;
}

function checkMessages(name: string): string {
  const dir = mailboxes[name];
  const files = readdirSync(dir).sort();
  if (files.length === 0) return "No new messages.";
  const messages: string[] = [];
  for (const f of files) {
    const content = readFileSync(join(dir, f), "utf-8");
    const from = f.match(/from-(\w+)/)?.[1] ?? "unknown";
    messages.push(`**From ${from}:**\n${content}`);
    unlinkSync(join(dir, f));
  }
  return messages.join("\n\n---\n\n");
}

function makeTools(agentName: string, otherName: string): ToolDefinition[] {
  return [
    {
      name: "send_message",
      label: "Send Message",
      description: `Send a message to ${otherName}.`,
      parameters: Type.Object({ message: Type.String() }),
      execute: async (_id, params) => {
        const result = sendMessage(otherName, agentName, params.message);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "check_messages",
      label: "Check Messages",
      description: "Check your inbox for new messages.",
      parameters: Type.Object({}),
      execute: async () => {
        const result = checkMessages(agentName);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

const WEB_SEARCH_EXT = "/home/cp/.pi/packagemanager/packages/web-search/extensions/web-search.ts";

async function main() {
  console.log("🚀 Spike: Agent with Web Search Extension\n");

  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);
  const model = getModel("anthropic", "claude-haiku-3-5-20241022");

  // --- Alice: no extensions, just messaging ---
  const { session: alice } = await createAgentSession({
    model,
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
    tools: [],
    customTools: makeTools("alice", "bob"),
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    systemPromptOverride: `You are Alice. You need Bob to research something for you.
Use send_message to ask Bob questions. Use check_messages to read replies.
After getting Bob's answer, summarize what you learned. Keep messages short.`,
  });
  console.log("✅ Alice created (no extensions)\n");

  // --- Bob: has web-search extension loaded ---
  const bobSettings = SettingsManager.inMemory({ compaction: { enabled: false } });
  const bobLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: "/home/cp/.pi/agent",
    additionalExtensionPaths: [WEB_SEARCH_EXT],
    settingsManager: bobSettings,
  });
  await bobLoader.reload();

  const bobExtensions = bobLoader.getExtensions();
  console.log(`📦 Bob's extensions loaded:`, typeof bobExtensions, Array.isArray(bobExtensions) ? bobExtensions.length : JSON.stringify(Object.keys(bobExtensions || {}).slice(0, 10)));

  const { session: bob } = await createAgentSession({
    model,
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
    tools: [],
    customTools: makeTools("bob", "alice"),
    sessionManager: SessionManager.inMemory(),
    settingsManager: bobSettings,
    resourceLoader: bobLoader,
    systemPromptOverride: `You are Bob, a research assistant. You have a web_search tool.
Use check_messages to read requests from Alice.
When Alice asks a question, use web_search to find the answer, then send_message the result back.
Keep your reply concise — summarize the key finding in 2-3 sentences.`,
  });
  console.log("✅ Bob created (with web-search extension)\n");

  // Log tool calls for visibility
  bob.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      console.log(`  🔧 Bob using tool: ${event.toolName}`);
    }
  });

  // --- Run the conversation ---
  console.log("--- Conversation Start ---\n");

  console.log("📍 Alice asks Bob a research question...");
  await alice.prompt(
    "Ask Bob to look up what the latest version of Bun.js is and what new features it has. Send him a message."
  );

  // Give a moment for mailbox
  await new Promise((r) => setTimeout(r, 1000));

  console.log("\n📍 Bob checks messages and researches...");
  await bob.prompt("Check your messages. If there's a question, use web_search to find the answer, then reply to Alice.");

  await new Promise((r) => setTimeout(r, 1000));

  console.log("\n📍 Alice reads the answer...");
  await alice.prompt("Check your messages and summarize what Bob found.");

  console.log("\n\n🏁 Done!");
  console.log(`Alice turns: ${alice.messages.length}`);
  console.log(`Bob turns: ${bob.messages.length}`);

  alice.dispose();
  bob.dispose();
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
