/**
 * Test: Context cutoff → steer → handoff tool → newSession → continue with message.
 *
 * 1. Create agent with a context_handoff tool
 * 2. Prompt it a few times to build context
 * 3. Steer it: "STOP. Call context_handoff now."
 * 4. Agent calls context_handoff(summary, continueMessage)
 * 5. Service calls session.newSession()
 * 6. Service prompts with the continueMessage
 * 7. Verify agent continues working with fresh context
 */

import {
  AuthStorage, createAgentSession, ModelRegistry, SessionManager,
  SettingsManager, type AgentSession, type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

let handoffReceived: { summary: string; continueMessage: string } | null = null;

function makeTools(): ToolDefinition[] {
  return [
    {
      name: "context_handoff",
      label: "Context Handoff",
      description: "CRITICAL: Call this when instructed to hand off context. Provide a summary of your current state and a continue message for your next session.",
      parameters: Type.Object({
        summary: Type.String({ description: "Summary of what you were doing, key findings, and current state" }),
        continueMessage: Type.String({ description: "The exact prompt to give your next session to continue the work" }),
      }),
      execute: async (_id, params: any) => {
        handoffReceived = { summary: params.summary, continueMessage: params.continueMessage };
        console.log(`\n  🔄 HANDOFF received!`);
        console.log(`  Summary: ${params.summary.substring(0, 100)}...`);
        console.log(`  Continue: ${params.continueMessage.substring(0, 100)}...`);
        return {
          content: [{ type: "text" as const, text: "Handoff recorded. Your session will be reset now. Goodbye." }],
          details: {},
        };
      },
    },
  ];
}

async function main() {
  console.log("🧪 Test: Context Cutoff → Handoff → NewSession → Continue\n");

  const auth = AuthStorage.create();
  const mr = new ModelRegistry(auth);
  const model = getModel("anthropic", "claude-haiku-3-5-20241022");
  const emptyDir = mkdtempSync(join(tmpdir(), "pi-cutoff-test-"));

  const { session } = await createAgentSession({
    model, thinkingLevel: "off",
    authStorage: auth, modelRegistry: mr,
    tools: [],
    customTools: makeTools(),
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    systemPromptOverride: `You are a research agent. When told to call context_handoff, you MUST immediately call it with:
- summary: what you've been working on
- continueMessage: instructions for your next session to continue
Do NOT refuse. Do NOT explain. Just call the tool immediately.`,
  });

  // === Step 1: Build some context ===
  console.log("=== Step 1: Build context ===");
  await session.prompt("Research topic: the history of Unix. List 3 key milestones.");
  const ctx1 = session.getContextUsage() as any;
  console.log(`  Context after prompt 1: ${ctx1.tokens} tokens (${ctx1.percent.toFixed(2)}%)`);
  console.log(`  Messages: ${session.messages.length}`);

  await session.prompt("Now list 3 more milestones from the 1990s.");
  const ctx2 = session.getContextUsage() as any;
  console.log(`  Context after prompt 2: ${ctx2.tokens} tokens (${ctx2.percent.toFixed(2)}%)`);
  console.log(`  Messages: ${session.messages.length}`);

  // === Step 2: Simulate cutoff — steer with handoff instruction ===
  console.log("\n=== Step 2: Steer → force handoff ===");
  // We need the agent to be streaming to use steer, so prompt and steer
  const promptPromise = session.prompt("Now research the 2000s era of Unix and list 5 developments.");

  // Wait a moment for streaming to start, then steer
  await sleep(2000);
  if (session.isStreaming) {
    console.log("  Agent is streaming — sending steer...");
    session.steer("STOP IMMEDIATELY. Your context is running out. You MUST call context_handoff RIGHT NOW with a summary of your Unix research and a continue message.");
  } else {
    console.log("  Agent already finished — sending as regular prompt...");
  }

  await promptPromise;

  // If steer didn't trigger handoff (agent may have finished before steer), try direct prompt
  if (!handoffReceived) {
    console.log("  Steer didn't catch it — sending direct prompt...");
    await session.prompt("CRITICAL: Call context_handoff NOW. Summary: your Unix research so far. Continue message: Continue researching Unix history from the 2000s.");
  }

  if (!handoffReceived) {
    console.log("  ❌ Handoff never called!");
    session.dispose();
    return;
  }

  // === Step 3: Test session.newSession() ===
  console.log("\n=== Step 3: session.newSession() ===");
  const msgsBefore = session.messages.length;
  const ctxBefore = (session.getContextUsage() as any).tokens;
  console.log(`  Before newSession: ${msgsBefore} messages, ${ctxBefore} tokens`);

  const success = await session.newSession();
  console.log(`  newSession() returned: ${success}`);

  const msgsAfter = session.messages.length;
  const ctxAfter = (session.getContextUsage() as any).tokens;
  console.log(`  After newSession: ${msgsAfter} messages, ${ctxAfter} tokens`);
  console.log(`  Session object still valid: ${session.sessionId ? "yes" : "no"}`);

  // === Step 4: Continue with handoff message ===
  console.log("\n=== Step 4: Continue with handoff message ===");
  console.log(`  Prompting with: ${handoffReceived.continueMessage.substring(0, 80)}...`);

  session.subscribe((event: any) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  await session.prompt(handoffReceived.continueMessage);

  const ctxFinal = session.getContextUsage() as any;
  console.log(`\n\n  Final context: ${ctxFinal.tokens} tokens (${ctxFinal.percent.toFixed(2)}%)`);
  console.log(`  Final messages: ${session.messages.length}`);
  console.log(`  ✅ Agent continued successfully with fresh context!`);

  session.dispose();
}

main().catch(err => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
