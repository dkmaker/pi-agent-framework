/**
 * Spike: Fully async agents — both run simultaneously, no turn-taking orchestration.
 *
 * Each agent runs in its own async loop:
 * 1. Check messages
 * 2. If message found, reply
 * 3. Wait a bit, repeat
 *
 * Alice starts the conversation. Both loops run concurrently via Promise.all.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

// --- Mailbox ---
const MAILBOX_DIR = join(import.meta.dirname, "mailbox-async");
const mkMailbox = (name: string) => {
  const dir = join(MAILBOX_DIR, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const mailboxes: Record<string, string> = {
  alice: mkMailbox("alice"),
  bob: mkMailbox("bob"),
};

// Track message counts per agent
const messageCounts: Record<string, number> = { alice: 0, bob: 0 };
const MAX_MESSAGES = 5;

function sendMessage(to: string, from: string, content: string): string {
  messageCounts[from]++;
  const count = messageCounts[from];
  const filename = `${Date.now()}-${count}-from-${from}.md`;
  writeFileSync(join(mailboxes[to], filename), content);
  console.log(`  📤 [${new Date().toISOString().slice(11, 23)}] ${from} → ${to} (msg #${count}): ${content.substring(0, 60)}...`);
  return `Message sent to ${to} (you have sent ${count}/${MAX_MESSAGES} messages total)`;
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
      parameters: Type.Object({
        message: Type.String({ description: "The message to send" }),
      }),
      execute: async (_id, params) => {
        const result = sendMessage(otherName, agentName, params.message);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
    {
      name: "check_messages",
      label: "Check Messages",
      description: "Check your inbox for new messages from the other agent.",
      parameters: Type.Object({}),
      execute: async () => {
        const result = checkMessages(agentName);
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

async function createAgent(
  name: string,
  otherName: string,
  systemPrompt: string,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
): Promise<AgentSession> {
  const model = getModel("anthropic", "claude-haiku-3-5-20241022");

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
    tools: [],
    customTools: makeTools(name, otherName),
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    systemPromptOverride: systemPrompt,
  });

  return session;
}

async function runAgentLoop(session: AgentSession, name: string, isStarter: boolean) {
  if (isStarter) {
    console.log(`\n🟢 ${name} starting conversation...`);
    await session.prompt(
      "Start the conversation! Send a short message about an interesting programming concept. Then STOP."
    );
  }

  for (let round = 0; round < MAX_MESSAGES; round++) {
    // Wait a bit for the other agent to respond
    await new Promise((r) => setTimeout(r, 2000));

    if (messageCounts[name] >= MAX_MESSAGES) {
      console.log(`\n🏁 ${name} reached ${MAX_MESSAGES} messages, stopping.`);
      break;
    }

    console.log(`\n🔄 ${name} checking messages (round ${round + 1})...`);
    await session.prompt(
      `Check your messages. If there's a new message, reply to it with a short response. If no messages, just say "waiting". You have sent ${messageCounts[name]}/${MAX_MESSAGES} messages so far. Stop after replying.`
    );
  }

  return name;
}

async function main() {
  console.log("🚀 Spike: ASYNC Agent Communication Test\n");
  console.log("Both agents will run SIMULTANEOUSLY via Promise.all\n");

  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  const alice = await createAgent(
    "alice", "bob",
    `You are Alice, a cheerful programmer. You're chatting with Bob about programming.
Rules: Use send_message to talk. Use check_messages to read replies. Keep messages to 1 sentence. Send at most ${MAX_MESSAGES} messages total. After each send, STOP immediately.`,
    authStorage, modelRegistry,
  );

  const bob = await createAgent(
    "bob", "alice",
    `You are Bob, a grumpy senior dev. You're chatting with Alice about programming.
Rules: Use check_messages to read. Use send_message to reply. Keep messages to 1 sentence, grumpy but accurate. Send at most ${MAX_MESSAGES} messages total. After each send, STOP immediately.`,
    authStorage, modelRegistry,
  );

  console.log("✅ Both agents created. Launching async loops...\n");

  const startTime = Date.now();

  // Run BOTH agents simultaneously
  const results = await Promise.all([
    runAgentLoop(alice, "alice", true),
    runAgentLoop(bob, "bob", false),
  ]);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n\n🏁 Done! Both agents finished.`);
  console.log(`⏱️  Total time: ${elapsed}s`);
  console.log(`📊 Alice sent: ${messageCounts.alice} messages`);
  console.log(`📊 Bob sent: ${messageCounts.bob} messages`);
  console.log(`📊 Alice session: ${alice.messages.length} turns`);
  console.log(`📊 Bob session: ${bob.messages.length} turns`);

  alice.dispose();
  bob.dispose();
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
