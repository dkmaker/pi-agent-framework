import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, SettingsManager, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

async function main() {
  const auth = AuthStorage.create();
  const mr = new ModelRegistry(auth);
  const model = getModel("anthropic", "claude-haiku-3-5-20241022");

  // Empty agentDir = no global stuff
  const emptyAgentDir = mkdtempSync(join(tmpdir(), "pi-agent-isolated-"));
  
  // But cwd = real project root (has .pi/ with PM database)
  const projectRoot = "/home/cp/code/pi/agent-framework";

  const settings = SettingsManager.inMemory({ compaction: { enabled: false } });

  const pmExtPath = "/home/cp/.pi/packagemanager/packages/pi-extension-project-management/index.ts";

  const loader = new DefaultResourceLoader({
    cwd: projectRoot,          // real project — has .pi/
    agentDir: emptyAgentDir,   // empty — no global extensions
    additionalExtensionPaths: [pmExtPath],
    settingsManager: settings,
    systemPromptOverride: () => "You are a worker agent.",
  });
  await loader.reload();

  const exts = loader.getExtensions();
  console.log("Extensions found:", JSON.stringify((exts as any).extensions?.map((e: any) => e.name) ?? []));

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

  const tools = session.getActiveToolNames();
  console.log(`\nActive tools (${tools.length}):`, JSON.stringify(tools));

  session.dispose();
}

main().catch(e => { console.error(e); process.exit(1); });
