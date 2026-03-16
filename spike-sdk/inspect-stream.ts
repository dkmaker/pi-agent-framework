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
    systemPromptOverride: "Be brief but write at least 3 sentences.",
  });

  let lastTokenTime = Date.now();
  let tokenCount = 0;

  session.subscribe((event: any) => {
    const now = Date.now();

    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      const gap = now - lastTokenTime;
      tokenCount++;
      if (tokenCount <= 10 || tokenCount % 20 === 0) {
        console.log(`  token #${tokenCount} (+${gap}ms): "${event.assistantMessageEvent.delta.substring(0, 30)}"`);
      }
      lastTokenTime = now;
    }

    if (event.type === "turn_start") {
      console.log(`\n⏱️  turn_start at ${new Date().toISOString().slice(11, 23)}`);
      lastTokenTime = now;
      tokenCount = 0;
    }

    if (event.type === "turn_end") {
      console.log(`⏱️  turn_end at ${new Date().toISOString().slice(11, 23)} — ${tokenCount} tokens total`);
    }

    if (event.type === "tool_execution_start") {
      console.log(`🔧 tool_execution_start: ${event.toolName} at ${new Date().toISOString().slice(11, 23)}`);
    }
    if (event.type === "tool_execution_end") {
      console.log(`🔧 tool_execution_end: ${event.toolName} at ${new Date().toISOString().slice(11, 23)}`);
    }

    // Check for state info
    if (event.type === "agent_start" || event.type === "agent_end") {
      console.log(`🤖 ${event.type} — session.isStreaming=${session.isStreaming}, session.state=${session.state}`);
    }
  });

  console.log("=== Prompting... ===");
  console.log(`session.isStreaming before: ${session.isStreaming}`);
  console.log(`session.state before: ${session.state}`);

  await session.prompt("Explain why TypeScript is popular. Write 3 sentences.");

  console.log(`\nsession.isStreaming after: ${session.isStreaming}`);
  console.log(`session.state after: ${session.state}`);

  session.dispose();
}

main().catch(e => { console.error(e); process.exit(1); });
