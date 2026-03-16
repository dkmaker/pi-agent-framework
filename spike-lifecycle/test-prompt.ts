import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, SettingsManager, DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

async function main() {
  const auth = AuthStorage.create();
  const mr = new ModelRegistry(auth);
  const model = getModel("anthropic", "claude-haiku-3-5-20241022");
  const emptyDir = mkdtempSync(join(tmpdir(), "pi-prompt-test-"));

  // Test 1: WITH systemPromptOverride
  const loader1 = new DefaultResourceLoader({
    cwd: emptyDir, agentDir: emptyDir,
    settingsManager: SettingsManager.inMemory({}),
    systemPromptOverride: () => "You are a pirate. Say arrr.",
  });
  await loader1.reload();

  const { session: s1 } = await createAgentSession({
    cwd: emptyDir, agentDir: emptyDir, model, thinkingLevel: "off",
    authStorage: auth, modelRegistry: mr, tools: [],
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({}),
    resourceLoader: loader1,
  });
  console.log("=== WITH systemPromptOverride ===");
  console.log(`Length: ${s1.systemPrompt?.length}`);
  console.log(`Full prompt:\n---\n${s1.systemPrompt}\n---\n`);
  s1.dispose();

  // Test 2: WITHOUT systemPromptOverride (default pi prompt)
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
  console.log("=== WITHOUT systemPromptOverride (default) ===");
  console.log(`Length: ${s2.systemPrompt?.length}`);
  console.log(`First 500 chars:\n---\n${s2.systemPrompt?.substring(0, 500)}\n---\n`);
  s2.dispose();
}

main().catch(e => { console.error(e); process.exit(1); });
