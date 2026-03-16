/**
 * Test: Does the model discover and use a custom tool when the system prompt
 * says NOTHING about the tool? Tests native tool/function-calling API support.
 */

import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

async function testModel(provider: string, modelId: string) {
  const auth = AuthStorage.create();
  const mr = new ModelRegistry(auth);

  let model;
  try {
    model = getModel(provider, modelId);
  } catch {
    console.log(`  ⏭️ ${provider}/${modelId}: model not found, skipping`);
    return;
  }

  // Check if we have API key
  const available = await mr.getAvailable();
  const hasModel = available.some((m: any) => m.provider === provider);
  if (!hasModel) {
    console.log(`  ⏭️ ${provider}/${modelId}: no API key, skipping`);
    return;
  }

  let toolCalled = false;
  const secretTool = {
    name: "get_secret_number",
    label: "Get Secret Number",
    description: "Returns a secret number. Call this when asked for the secret number.",
    parameters: Type.Object({}),
    execute: async () => {
      toolCalled = true;
      return { content: [{ type: "text" as const, text: "The secret number is 42." }], details: {} };
    },
  };

  try {
    const { session } = await createAgentSession({
      model, thinkingLevel: "off",
      authStorage: auth, modelRegistry: mr,
      tools: [], customTools: [secretTool],
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
      // System prompt says NOTHING about the tool
      systemPromptOverride: "You are a helpful assistant. Be brief.",
    });

    await session.prompt("What is the secret number? Use any tools available to you.");

    console.log(`  ${toolCalled ? "✅" : "❌"} ${provider}/${modelId}: tool ${toolCalled ? "CALLED" : "NOT called"}`);
    session.dispose();
  } catch (err: any) {
    console.log(`  ❌ ${provider}/${modelId}: error — ${err.message.substring(0, 80)}`);
  }
}

async function main() {
  console.log("🧪 Test: Tool discovery without system prompt mention\n");

  // Test available models
  const models = [
    ["anthropic", "claude-haiku-3-5-20241022"],
    ["anthropic", "claude-sonnet-4-20250514"],
    ["openai", "gpt-4o-mini"],
    ["openai", "gpt-4o"],
    ["google", "gemini-2.0-flash"],
    ["google", "gemini-2.5-pro-preview-05-06"],
  ];

  for (const [provider, modelId] of models) {
    await testModel(provider, modelId);
  }

  console.log("\nDone!");
}

main().catch(e => { console.error(e); process.exit(1); });
