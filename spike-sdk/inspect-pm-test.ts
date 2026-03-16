import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, SettingsManager, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

async function main() {
  const auth = AuthStorage.create();
  const mr = new ModelRegistry(auth);
  const model = getModel("anthropic", "claude-haiku-3-5-20241022");

  const emptyAgentDir = mkdtempSync(join(tmpdir(), "pi-agent-isolated-"));
  const projectRoot = "/home/cp/code/pi/agent-framework";
  const pmExtPath = "/home/cp/.pi/packagemanager/packages/pi-extension-project-management/index.ts";

  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });

  const loader = new DefaultResourceLoader({
    cwd: projectRoot,
    agentDir: emptyAgentDir,
    additionalExtensionPaths: [pmExtPath],
    settingsManager: settings,
    systemPromptOverride: () => "You are a worker agent. Use the project management tools to check project status.",
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: projectRoot,
    agentDir: emptyAgentDir,
    model, thinkingLevel: "off",
    authStorage: auth, modelRegistry: mr,
    tools: [],
    sessionManager: SessionManager.inMemory(),
    settingsManager: settings,
    resourceLoader: loader,
  });

  session.subscribe((event: any) => {
    if (event.type === "tool_execution_start") {
      console.log(`🔧 ${event.toolName}`);
    }
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  await session.prompt("Show me the current project status — list all epics and any open issues.");

  console.log("\n\n✅ Done");
  session.dispose();
}

main().catch(e => { console.error(e); process.exit(1); });
