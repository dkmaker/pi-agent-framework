/**
 * Simplified cutoff test — skip steer, just test:
 * 1. prompt → build context
 * 2. prompt → call context_handoff
 * 3. newSession() → reset
 * 4. prompt → continue
 */

import {
  AuthStorage, createAgentSession, ModelRegistry, SessionManager,
  SettingsManager, type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let handoff: { summary: string; continueMessage: string } | null = null;

async function main() {
  console.log("🧪 Test: Context Handoff → NewSession → Continue\n");

  const auth = AuthStorage.create();
  const mr = new ModelRegistry(auth);
  const model = getModel("anthropic", "claude-haiku-3-5-20241022");
  const emptyDir = mkdtempSync(join(tmpdir(), "pi-cutoff-"));

  const handoffTool: ToolDefinition = {
    name: "context_handoff",
    label: "Context Handoff",
    description: "Call this to hand off your work to a fresh session.",
    parameters: Type.Object({
      summary: Type.String({ description: "What you were doing" }),
      continueMessage: Type.String({ description: "Prompt for next session" }),
    }),
    execute: async (_id, params: any) => {
      handoff = { summary: params.summary, continueMessage: params.continueMessage };
      console.log(`  🔄 Handoff received!`);
      return { content: [{ type: "text" as const, text: "Handoff recorded. Session will reset." }], details: {} };
    },
  };

  const { session } = await createAgentSession({
    model, thinkingLevel: "off",
    authStorage: auth, modelRegistry: mr,
    tools: [], customTools: [handoffTool],
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    systemPromptOverride: "You are a research agent. When asked to hand off, call context_handoff immediately.",
  });

  // Step 1: Build context
  console.log("Step 1: Build context");
  await session.prompt("List 5 important events in the history of computing.");
  const ctx1 = session.getContextUsage() as any;
  console.log(`  ${ctx1.tokens} tokens, ${session.messages.length} messages\n`);

  // Step 2: Force handoff
  console.log("Step 2: Force handoff");
  await session.prompt("Your context is running low. Call context_handoff now. Summary: your computing history research. Continue: 'Continue researching computing history, focus on the 2000s era.'");

  if (!handoff) {
    console.log("  ❌ No handoff!");
    session.dispose();
    return;
  }
  console.log(`  Summary: ${handoff.summary.substring(0, 80)}...`);
  console.log(`  Continue: ${handoff.continueMessage.substring(0, 80)}...\n`);

  // Step 3: newSession()
  console.log("Step 3: newSession()");
  const before = { msgs: session.messages.length, tokens: (session.getContextUsage() as any).tokens };
  console.log(`  Before: ${before.msgs} messages, ${before.tokens} tokens`);

  const ok = await session.newSession();
  console.log(`  newSession() returned: ${ok}`);

  const after = { msgs: session.messages.length, tokens: (session.getContextUsage() as any).tokens };
  console.log(`  After: ${after.msgs} messages, ${after.tokens} tokens`);
  console.log(`  Context reduced: ${before.tokens} → ${after.tokens}\n`);

  // Step 4: Continue
  console.log("Step 4: Continue with handoff message");
  await session.prompt(handoff.continueMessage);
  const final = session.getContextUsage() as any;
  console.log(`  Final: ${session.messages.length} messages, ${final.tokens} tokens`);

  console.log("\n✅ Full handoff cycle works!");
  session.dispose();
}

main().catch(err => { console.error("❌", err); process.exit(1); });
