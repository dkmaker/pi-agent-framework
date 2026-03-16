import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, SettingsManager, DefaultResourceLoader, createEventBus } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

async function main() {
  const auth = AuthStorage.create();
  const mr = new ModelRegistry(auth);
  const model = getModel("anthropic", "claude-haiku-3-5-20241022");

  // Use an empty temp dir as agentDir — no global extensions, skills, prompts, themes
  const emptyAgentDir = mkdtempSync(join(tmpdir(), "pi-agent-isolated-"));
  // Use another empty dir as cwd — no project extensions either  
  const emptyCwd = mkdtempSync(join(tmpdir(), "pi-agent-cwd-"));

  console.log("=== Test: Fully isolated agent ===");
  console.log(`agentDir: ${emptyAgentDir} (empty)`);
  console.log(`cwd: ${emptyCwd} (empty)`);

  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });

  // Create resource loader pointing at empty dirs
  const loader = new DefaultResourceLoader({
    cwd: emptyCwd,
    agentDir: emptyAgentDir,
    settingsManager: settings,
    systemPromptOverride: () => "You are a test agent. Only use the tools provided.",
  });
  await loader.reload();

  const extensions = loader.getExtensions();
  const skills = loader.getSkills();
  const prompts = loader.getPrompts();
  const themes = loader.getThemes();

  console.log(`\nLoaded extensions:`, JSON.stringify(extensions.extensions?.map((e: any) => e.name) ?? Object.keys(extensions)));
  console.log(`Loaded skills:`, JSON.stringify(skills));
  console.log(`Loaded prompts:`, JSON.stringify(prompts));
  console.log(`Loaded themes:`, JSON.stringify(themes));

  // Only our custom tool
  const myTool = {
    name: "ping",
    label: "Ping",
    description: "Returns pong",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text" as const, text: "pong" }], details: {} }),
  };

  const { session } = await createAgentSession({
    cwd: emptyCwd,
    agentDir: emptyAgentDir,
    model,
    thinkingLevel: "off",
    authStorage: auth,
    modelRegistry: mr,
    tools: [],          // NO built-in coding tools
    customTools: [myTool], // ONLY our tool
    sessionManager: SessionManager.inMemory(),
    settingsManager: settings,
    resourceLoader: loader,
  });

  // Check what tools the agent actually has
  const activeTools = session.getActiveToolNames();
  console.log(`\nActive tools: ${JSON.stringify(activeTools)}`);

  // Check system prompt
  console.log(`\nSystem prompt preview: "${session.systemPrompt?.substring(0, 100)}..."`);
  console.log(`System prompt length: ${session.systemPrompt?.length} chars`);

  // Quick test
  session.subscribe((event: any) => {
    if (event.type === "tool_execution_start") {
      console.log(`🔧 Tool called: ${event.toolName}`);
    }
  });

  await session.prompt("Use the ping tool.");
  console.log(`\n✅ Agent worked with only the ping tool.`);

  session.dispose();
}

main().catch(e => { console.error(e); process.exit(1); });
