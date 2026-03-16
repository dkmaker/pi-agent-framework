import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";

async function main() {
  const auth = AuthStorage.create();
  const mr = new ModelRegistry(auth);
  const model = getModel("anthropic", "claude-haiku-3-5-20241022");

  const { session } = await createAgentSession({
    model, thinkingLevel: "off", authStorage: auth, modelRegistry: mr,
    tools: [], sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    systemPromptOverride: "Be brief.",
  });

  await session.prompt("Say hello.");
  await session.prompt("Say goodbye.");

  console.log("=== getContextUsage() ===");
  console.log(JSON.stringify(session.getContextUsage(), null, 2));

  console.log("\n=== getSessionStats() ===");
  console.log(JSON.stringify(session.getSessionStats(), null, 2));

  console.log("\n=== messages count ===");
  console.log(session.messages.length);

  // Aggregate usage from messages
  let totalInput = 0, totalOutput = 0, totalCost = 0;
  let turns = 0;
  for (const m of session.messages) {
    const msg = m as any;
    if (msg.usage) {
      totalInput += msg.usage.input || 0;
      totalOutput += msg.usage.output || 0;
      totalCost += msg.usage.cost?.total || 0;
      turns++;
    }
  }
  console.log(`\n=== Aggregated from messages ===`);
  console.log(`  Assistant turns: ${turns}`);
  console.log(`  Total input tokens: ${totalInput}`);
  console.log(`  Total output tokens: ${totalOutput}`);
  console.log(`  Total cost: $${totalCost.toFixed(6)}`);

  session.dispose();
}

main().catch(e => { console.error(e); process.exit(1); });
