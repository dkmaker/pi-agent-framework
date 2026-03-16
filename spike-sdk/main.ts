/**
 * Spike: Two SDK-spawned agents exchange 5 messages via filesystem mailbox.
 *
 * Agent "Alice" — cheerful, asks questions about coding
 * Agent "Bob"   — grumpy, answers reluctantly but accurately
 *
 * Flow:
 * 1. Create two AgentSession instances with different system prompts
 * 2. Give each a custom "send_message" tool that writes to the other's mailbox
 * 3. Give each a custom "check_messages" tool that reads from their own mailbox
 * 4. Prompt Alice to start a conversation
 * 5. Relay messages between them for 5 exchanges
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from "fs";
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

// --- Mailbox setup ---
const MAILBOX_DIR = join(import.meta.dirname, "mailbox");
const mkMailbox = (name: string) => {
  const dir = join(MAILBOX_DIR, name);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const aliceMailbox = mkMailbox("alice");
const bobMailbox = mkMailbox("bob");

function sendMessage(to: string, from: string, content: string): string {
  const targetDir = to === "alice" ? aliceMailbox : bobMailbox;
  const filename = `${Date.now()}-from-${from}.md`;
  writeFileSync(join(targetDir, filename), content);
  return `Message sent to ${to}`;
}

function checkMessages(name: string): string {
  const dir = name === "alice" ? aliceMailbox : bobMailbox;
  const files = readdirSync(dir).sort();
  if (files.length === 0) return "No new messages.";

  const messages: string[] = [];
  for (const f of files) {
    const content = readFileSync(join(dir, f), "utf-8");
    const from = f.match(/from-(\w+)/)?.[1] ?? "unknown";
    messages.push(`**From ${from}:**\n${content}`);
    unlinkSync(join(dir, f)); // read-once
  }
  return messages.join("\n\n---\n\n");
}

// --- Tool factories ---
function makeTools(agentName: string, otherName: string): ToolDefinition[] {
  return [
    {
      name: "send_message",
      label: "Send Message",
      description: `Send a message to ${otherName}. Use this to communicate.`,
      parameters: Type.Object({
        message: Type.String({ description: "The message content to send" }),
      }),
      execute: async (_id, params) => {
        const result = sendMessage(otherName, agentName, params.message);
        console.log(`  📤 ${agentName} → ${otherName}: ${params.message.substring(0, 80)}...`);
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
        if (result !== "No new messages.") {
          console.log(`  📥 ${agentName} received message`);
        }
        return { content: [{ type: "text" as const, text: result }], details: {} };
      },
    },
  ];
}

// --- Create an agent session ---
async function createAgent(
  name: string,
  otherName: string,
  systemPrompt: string,
  authStorage: AuthStorage,
  modelRegistry: ModelRegistry,
): Promise<AgentSession> {
  const model = getModel("anthropic", "claude-sonnet-4-20250514");

  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
  });

  const { session } = await createAgentSession({
    model,
    thinkingLevel: "off",
    authStorage,
    modelRegistry,
    tools: [], // no coding tools — just messaging
    customTools: makeTools(name, otherName),
    sessionManager: SessionManager.inMemory(),
    settingsManager,
    systemPromptOverride: systemPrompt,
  });

  // Log text output
  session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      // silent — we only care about tool calls for this spike
    }
    if (event.type === "agent_end") {
      console.log(`  ✅ ${name} turn complete`);
    }
  });

  return session;
}

// --- Main ---
async function main() {
  console.log("🚀 Spike: SDK Agent Communication Test\n");

  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  console.log("Creating Alice (cheerful, curious)...");
  const alice = await createAgent(
    "alice",
    "bob",
    `You are Alice, a cheerful and curious programmer. You are having a conversation with Bob.
Your goal: Exchange exactly 5 messages with Bob about interesting programming topics.
Rules:
- Always use send_message to talk to Bob
- Always use check_messages to read Bob's replies
- After sending a message, STOP and wait. Do NOT send another message until told to continue.
- Keep messages short (1-2 sentences).
- Count your messages. After you have SENT your 5th message, say "CONVERSATION COMPLETE" in your text output.`,
    authStorage,
    modelRegistry,
  );

  console.log("Creating Bob (grumpy, knowledgeable)...");
  const bob = await createAgent(
    "bob",
    "alice",
    `You are Bob, a grumpy but brilliant senior programmer. You are having a conversation with Alice.
Rules:
- When you receive a message, reply using send_message
- Always use check_messages first to see if there are messages
- Keep responses short and grumpy but technically accurate (1-2 sentences)
- After replying, STOP and wait. Do NOT send another message until told to continue.`,
    authStorage,
    modelRegistry,
  );

  console.log("\n--- Starting conversation ---\n");

  // Round 1: Alice starts
  console.log("📍 Round 1: Alice starts the conversation");
  await alice.prompt("Start the conversation with Bob! Send him a message about something interesting in programming. Then stop and wait.");

  // Rounds 2-5: Relay messages
  for (let round = 2; round <= 5; round++) {
    console.log(`\n📍 Round ${round}: Bob checks and replies`);
    await bob.prompt("Check your messages and reply to the latest one. Then stop and wait.");

    console.log(`\n📍 Round ${round}: Alice checks and replies`);
    await alice.prompt("Check your messages and reply to the latest one. Then stop and wait.");
  }

  // Final: Bob gets last word
  console.log("\n📍 Final: Bob checks and replies one last time");
  await bob.prompt("Check your messages and reply. This is the last message in our conversation.");

  console.log("\n\n🏁 Conversation complete!");
  console.log("\n--- Summary ---");
  console.log(`Alice messages: ${alice.messages.length} turns`);
  console.log(`Bob messages: ${bob.messages.length} turns`);

  // Cleanup
  alice.dispose();
  bob.dispose();
}

main().catch((err) => {
  console.error("❌ Fatal error:", err);
  process.exit(1);
});
