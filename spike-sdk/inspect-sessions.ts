import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

async function main() {
  const auth = AuthStorage.create();
  const mr = new ModelRegistry(auth);
  const model = getModel("anthropic", "claude-haiku-3-5-20241022");

  const sessionDir = join(import.meta.dirname, "test-sessions");

  // --- Test 1: In-memory session — what's on session.messages? ---
  console.log("=== Test 1: In-memory session ===");
  const { session: memSession } = await createAgentSession({
    model, thinkingLevel: "off", authStorage: auth, modelRegistry: mr,
    tools: [], sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    systemPromptOverride: "Reply in one word only.",
  });

  await memSession.prompt("Say yes.");
  console.log("messages:", memSession.messages.length);
  console.log("sessionFile:", memSession.sessionFile);
  console.log("sessionId:", memSession.sessionId);
  memSession.dispose();

  // --- Test 2: Persistent session — what gets written to disk? ---
  console.log("\n=== Test 2: Persistent session ===");
  const { session: diskSession } = await createAgentSession({
    cwd: sessionDir,
    model, thinkingLevel: "off", authStorage: auth, modelRegistry: mr,
    tools: [], sessionManager: SessionManager.create(sessionDir),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    systemPromptOverride: "Reply in one word only.",
  });

  await diskSession.prompt("Say hello.");
  await diskSession.prompt("Say goodbye.");

  console.log("messages:", diskSession.messages.length);
  console.log("sessionFile:", diskSession.sessionFile);
  console.log("sessionId:", diskSession.sessionId);

  // Read the session file
  if (diskSession.sessionFile) {
    const content = readFileSync(diskSession.sessionFile, "utf-8");
    const lines = content.trim().split("\n");
    console.log(`\nSession file: ${lines.length} JSONL entries`);
    for (const line of lines) {
      const entry = JSON.parse(line);
      const preview = JSON.stringify(entry).substring(0, 150);
      console.log(`  ${preview}...`);
    }
  }

  // Check session directory
  console.log("\n=== Session directory contents ===");
  try {
    const sessionsDir = join(sessionDir, ".pi", "sessions");
    const walk = (dir: string, prefix = "") => {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory()) walk(join(dir, f.name), prefix + f.name + "/");
        else console.log(`  ${prefix}${f.name}`);
      }
    };
    walk(sessionsDir);
  } catch (e: any) {
    console.log("  Could not read sessions dir:", e.message);
  }

  diskSession.dispose();
}

main().catch(e => { console.error(e); process.exit(1); });
