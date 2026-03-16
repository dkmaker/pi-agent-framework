import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, SettingsManager, DefaultResourceLoader, codingTools } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

async function main() {
  const auth = AuthStorage.create();
  const mr = new ModelRegistry(auth);
  const model = getModel("anthropic", "claude-haiku-3-5-20241022");
  const emptyDir = mkdtempSync(join(tmpdir(), "pi-prompt-"));

  // Default with coding tools
  const loader1 = new DefaultResourceLoader({
    cwd: emptyDir, agentDir: emptyDir,
    settingsManager: SettingsManager.inMemory({}),
  });
  await loader1.reload();
  const { session: s1 } = await createAgentSession({
    cwd: emptyDir, agentDir: emptyDir, model, thinkingLevel: "off",
    authStorage: auth, modelRegistry: mr,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({}),
    resourceLoader: loader1,
  });
  console.log("=== Default (with coding tools) ===");
  console.log(s1.systemPrompt);
  console.log("\n--- END ---\n");
  s1.dispose();

  // Default with NO tools
  const loader2 = new DefaultResourceLoader({
    cwd: emptyDir, agentDir: emptyDir,
    settingsManager: SettingsManager.inMemory({}),
  });
  await loader2.reload();
  const { session: s2 } = await createAgentSession({
    cwd: emptyDir, agentDir: emptyDir, model, thinkingLevel: "off",
    authStorage: auth, modelRegistry: mr, tools: [],
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({}),
    resourceLoader: loader2,
  });
  console.log("=== Default (no tools) ===");
  console.log(s2.systemPrompt);
  console.log("\n--- END ---\n");
  s2.dispose();
}

main().catch(e => { console.error(e); process.exit(1); });
