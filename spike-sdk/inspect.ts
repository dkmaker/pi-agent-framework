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

  const agent = session.agent;
  console.log("=== session prototype ===");
  console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(session)).sort().join(", "));
  console.log("\n=== agent prototype ===");
  console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(agent)).sort().join(", "));

  // Capture all events
  const allEvents: any[] = [];
  session.subscribe((event: any) => {
    allEvents.push(event);
  });

  await session.prompt("Say hello in one word.");

  console.log("\n=== All event types ===");
  const types = [...new Set(allEvents.map(e => e.type))];
  console.log(types.sort().join(", "));

  // Dump interesting events
  for (const ev of allEvents) {
    if (["turn_end", "agent_end", "message_end", "message_start"].includes(ev.type)) {
      console.log(`\n--- ${ev.type} ---`);
      for (const [k, v] of Object.entries(ev)) {
        if (k === "type") continue;
        if (typeof v === "object" && v !== null) {
          console.log(`  ${k}:`, JSON.stringify(v).substring(0, 300));
        } else {
          console.log(`  ${k}:`, v);
        }
      }
    }
  }

  // Check agent properties
  console.log("\n=== agent properties ===");
  for (const k of ["contextWindow", "tokenUsage", "usage", "context", "maxTokens", "totalTokens"]) {
    const v = (agent as any)[k];
    if (v !== undefined) console.log(`  agent.${k}:`, JSON.stringify(v).substring(0, 200));
  }

  // Check messages for usage
  console.log("\n=== messages ===");
  for (const msg of session.messages) {
    const m = msg as any;
    console.log(`  role=${m.role}, keys=[${Object.keys(m).join(",")}]`);
    if (m.usage) console.log("    usage:", JSON.stringify(m.usage));
    if (m.tokenUsage) console.log("    tokenUsage:", JSON.stringify(m.tokenUsage));
  }

  session.dispose();
}

main().catch(e => { console.error(e); process.exit(1); });
