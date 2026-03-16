/**
 * Test runner — runs all unit tests for pi-agent-service.
 *
 * Usage: npm test (or: npx tsx test/run-tests.ts)
 */

import * as fs from "fs";
import * as path from "path";
import { SettingsLoader } from "../src/settings.js";
import { TraceWriter } from "../src/trace.js";
import { MessageRouter, RouterError } from "../src/router.js";
import { HealthMonitor } from "../src/health.js";
import { CutoffMonitor } from "../src/cutoff.js";
import { SubscriptionManager } from "../src/subscriptions.js";
import { buildSystemPrompt, buildMessageOverview } from "../src/prompt-builder.js";
import { buildAgentTools } from "../src/agent-tools.js";
import type { TraceEntry } from "../src/types.js";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

function tmpDir(): string {
  const dir = `/tmp/pi-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Settings Tests ───────────────────────────────────────────

async function testSettings() {
  console.log("▸ Settings Loader");
  const tmp = tmpDir();

  const loader = await SettingsLoader.create(tmp);
  const s = loader.getSettings();

  assert(s.defaults.model === "claude-sonnet-4-20250514", "default model");
  assert(s.service.socket_path === "/tmp/pi-agent-service.sock", "default socket path");
  assert(Array.isArray(s.acl), "acl is array");
  assert(Array.isArray(s.agents), "agents is array");

  // File written with all fields
  const written = JSON.parse(fs.readFileSync(path.join(tmp, ".pi/agents/settings.json"), "utf-8"));
  assert(Object.keys(written).length === 5, "settings has 5 top-level keys");
  assert(written.defaults.cutoff_polite_pct === 70, "default cutoff");

  // ACL update
  await loader.updateAcl([{ from: "worker", to: ["manager"] }]);
  const reread = JSON.parse(fs.readFileSync(path.join(tmp, ".pi/agents/settings.json"), "utf-8"));
  assert(reread.acl.length === 1, "ACL persisted");
  assert(reread.acl[0].from === "worker", "ACL content");

  // Merge partial settings
  fs.writeFileSync(path.join(tmp, ".pi/agents/settings.json"), JSON.stringify({ defaults: { model: "gpt-4o" } }));
  await loader.reloadSettings();
  const merged = loader.getSettings();
  assert(merged.defaults.model === "gpt-4o", "merged model");
  assert(merged.defaults.provider === "anthropic", "preserved default provider");

  loader.dispose();
  fs.rmSync(tmp, { recursive: true });
}

// ─── Trace Tests ──────────────────────────────────────────────

async function testTrace() {
  console.log("▸ Trace Writer");
  const tmp = tmpDir();
  const trace = await TraceWriter.create(`${tmp}/trace.jsonl`);

  const e1 = trace.append({ type: "service_started" });
  assert(!!e1.id, "entry has id");
  assert(!!e1.ts, "entry has timestamp");
  assert(e1.type === "service_started", "entry has type");

  trace.append({ type: "agent_spawned", agent: "worker", config: {} });
  trace.append({ type: "agent_state", agent: "worker", from: "offline", to: "online-idle" });
  trace.append({ type: "message", agent: "worker", threadId: "t1", from: "manager", to: "worker", subject: "test" });
  trace.append({ type: "agent_health", agent: "reviewer", from: "healthy", to: "slow" });

  // JSONL format
  const lines = fs.readFileSync(`${tmp}/trace.jsonl`, "utf-8").trim().split("\n");
  assert(lines.length === 5, "5 lines in JSONL");

  // Query
  assert(trace.query({ limit: 100 }).length === 5, "query all");
  assert(trace.query({ type: "message" }).length === 1, "query by type");
  assert(trace.query({ agent: "worker" }).length === 3, "query by agent");
  assert(trace.query({ threadId: "t1" }).length === 1, "query by thread");
  assert(trace.query({ type: ["agent_spawned", "agent_state"] }).length === 2, "query multi-type");
  assert(trace.readAll().length === 5, "readAll");

  trace.dispose();
  fs.rmSync(tmp, { recursive: true });
}

// ─── Router Tests ─────────────────────────────────────────────

async function testRouter() {
  console.log("▸ Message Router");
  const tmp = tmpDir();
  const trace = await TraceWriter.create(`${tmp}/trace.jsonl`);
  const settings = await SettingsLoader.create(tmp);
  await settings.updateAcl([
    { from: "worker", to: ["reviewer"] },
    { from: "reviewer", to: ["worker"] },
  ]);

  const router = new MessageRouter(trace, settings);

  // ACL tests
  const r1 = router.sendMessage({ from: "manager", to: "worker", subject: "Task", body: "Do it" });
  assert(r1.status === "queued", "manager→worker queued");

  const r2 = router.sendMessage({ from: "worker", to: "reviewer", subject: "Review", body: "Check" });
  assert(r2.status === "queued", "worker→reviewer queued (ACL)");

  const r3 = router.sendMessage({ from: "worker", to: "unknown", subject: "X", body: "Y" });
  assert(r3.status === "dropped", "worker→unknown dropped (ACL)");

  // Queue
  const drained = router.drainQueue("worker");
  assert(drained?.subject === "Task", "drain returns oldest");
  assert(router.drainQueue("worker") === undefined, "queue empty after drain");

  // Important messages
  router.sendMessage({ from: "manager", to: "worker", subject: "Urgent", body: "!", priority: "important" });
  router.sendMessage({ from: "manager", to: "worker", subject: "Normal", body: "..." });
  assert(router.hasImportantMessages("worker"), "has important");
  const imp = router.drainImportant("worker");
  assert(imp?.subject === "Urgent", "drain important");

  // Thread limit
  const tlId = "thread-limit-test";
  let limitHit = false;
  try {
    for (let i = 0; i < 101; i++) {
      router.sendMessage({ from: "manager", to: "worker", subject: "Spam", body: `${i}`, threadId: tlId });
    }
  } catch (e: any) {
    limitHit = e.code === "THREAD_LIMIT";
  }
  assert(limitHit, "thread limit enforced at 100");

  // Threads
  const threads = router.getThreads({ agent: "reviewer" });
  assert(threads.length > 0, "threads exist");

  // State recovery
  const router2 = new MessageRouter(trace, settings);
  router2.restoreFromTrace(trace.readAll());
  assert(router2.getThreads().length > 0, "threads recovered");

  trace.dispose();
  settings.dispose();
  fs.rmSync(tmp, { recursive: true });
}

// ─── Health & Cutoff Tests ────────────────────────────────────

async function testHealthCutoff() {
  console.log("▸ Health & Cutoff");
  const tmp = tmpDir();
  const trace = await TraceWriter.create(`${tmp}/trace.jsonl`);

  // Health
  const health = new HealthMonitor(trace);
  assert(health.getHealth("worker") === "healthy", "initial healthy");
  health.start("worker");
  health.recordToken("worker");
  assert(health.getHealth("worker") === "healthy", "healthy after token");
  health.stop("worker");

  // Cutoff
  const cutoff = new CutoffMonitor(trace);
  assert(cutoff.checkOnAgentEnd("w", 50, 70, 90) === null, "below threshold");
  assert(cutoff.checkOnAgentEnd("w", 75, 70, 90)?.level === "polite", "polite at 75%");
  assert(cutoff.checkOnAgentEnd("w", 80, 70, 90) === null, "no repeat polite");
  assert(cutoff.checkOnAgentEnd("w", 92, 70, 90)?.level === "hard", "hard at 92%");
  assert(cutoff.isHardSteering("w"), "hard steering active");
  cutoff.reset("w");
  assert(!cutoff.isHardSteering("w"), "steering reset");
  assert(cutoff.checkOnAgentEnd("w", 72, 70, 90)?.level === "polite", "polite after reset");

  health.dispose();
  cutoff.dispose();
  trace.dispose();
  fs.rmSync(tmp, { recursive: true });
}

// ─── Subscriptions Tests ──────────────────────────────────────

function testSubscriptions() {
  console.log("▸ Subscriptions");
  const mgr = new SubscriptionManager();

  const entry = (type: string, extra: Record<string, unknown> = {}): TraceEntry =>
    ({ id: "t", ts: new Date().toISOString(), type: type as any, ...extra });

  // Subscribe + match
  const id1 = mgr.subscribe({ types: ["message"] }, 3);
  assert(!!id1, "subscribed");
  assert(mgr.match(entry("message")).length === 1, "match message");
  assert(mgr.match(entry("agent_state")).length === 0, "no match agent_state");

  // Expiry
  mgr.match(entry("message"));
  const r3 = mgr.match(entry("message"));
  assert(r3[0]?.subscriptionExpired === true, "expired on 3rd");
  assert(mgr.match(entry("message")).length === 0, "no match after expiry");

  // Agent filter
  mgr.subscribe({ agent: "worker" }, 100);
  assert(mgr.match(entry("agent_state", { agent: "worker" })).length === 1, "agent filter match");
  assert(mgr.match(entry("agent_state", { agent: "reviewer" })).length === 0, "agent filter no match");

  // Unsubscribe + cancelAll
  mgr.cancelAll();
  assert(mgr.getActiveSubscriptions().length === 0, "cancelAll");

  // Max limit
  const mgr2 = new SubscriptionManager();
  for (let i = 0; i < 20; i++) mgr2.subscribe({}, 100);
  let threw = false;
  try { mgr2.subscribe({}, 100); } catch { threw = true; }
  assert(threw, "max 20 limit");

  mgr.dispose();
  mgr2.dispose();
}

// ─── Prompt & Tools Tests ─────────────────────────────────────

async function testPromptAndTools() {
  console.log("▸ Prompt Builder & Agent Tools");
  const tmp = tmpDir();

  // Set up agent
  const agentDir = path.join(tmp, ".pi", "agents", "worker");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "agent.json"), JSON.stringify({ name: "worker", brief: "Codes stuff." }));
  fs.writeFileSync(path.join(agentDir, "SYSTEM.md"), "# Worker\nYou are a worker.");
  fs.writeFileSync(path.join(tmp, ".pi/agents/settings.json"), JSON.stringify({
    agents: [".pi/agents/worker"],
    acl: [{ from: "worker", to: ["reviewer"] }],
  }));

  const settings = await SettingsLoader.create(tmp);
  const trace = await TraceWriter.create(`${tmp}/trace.jsonl`);
  const router = new MessageRouter(trace, settings);

  // Prompt
  const prompt = buildSystemPrompt("worker", {
    getAgentConfig: (n) => settings.getAgentConfig(n),
    getAllAgentConfigs: () => settings.getAllAgentConfigs(),
    getAcl: () => settings.getAcl(),
    resolveAgentPath: (p) => settings.resolveAgentPath(p),
    getAgentPaths: () => settings.getSettings().agents,
  });

  assert(prompt.includes("Worker"), "has SYSTEM.md");
  assert(prompt.includes("Coding Guidelines"), "has coding guidelines");
  assert(prompt.includes("Codes stuff"), "has brief");
  assert(prompt.includes("Available Agents"), "has address book");
  assert(prompt.includes("UNATTENDED"), "has unattended instructions");

  // Message overview
  const overview = buildMessageOverview({
    unreadCount: 3,
    threads: [{ subject: "Feature X", with: "manager", messageCount: 5, lastActivity: "2min ago" }],
    handoffSummary: "Was working on parser.",
  });
  assert(overview.includes("3 unread"), "overview unread");
  assert(overview.includes("Feature X"), "overview thread");

  // Tools
  const tools = buildAgentTools("worker", router, trace, {
    onMessageSent: () => {},
    onContextHandoff: async () => {},
    getContextPercent: () => 45,
    getTokensUsed: () => 12500,
    getCost: () => 0.0234,
    getUptime: () => 3700,
  });

  assert(tools.length === 5, "5 tools");
  assert(tools.map((t) => t.name).includes("send_message"), "has send_message");
  assert(tools.map((t) => t.name).includes("context_handoff"), "has context_handoff");
  assert(tools.map((t) => t.name).includes("check_status"), "has check_status");

  // Execute send_message
  const sendResult = await tools[0].execute("tc1", { to: "manager", subject: "Done", message: "OK" }, undefined, undefined, {} as any);
  assert((sendResult.content[0] as any).text.includes("Sent to manager"), "send works");

  // Execute check_status
  const statusResult = await tools[4].execute("tc2", {}, undefined, undefined, {} as any);
  assert((statusResult.content[0] as any).text.includes("45%"), "status works");

  settings.dispose();
  trace.dispose();
  fs.rmSync(tmp, { recursive: true });
}

// ─── Run All ──────────────────────────────────────────────────

async function main() {
  console.log("\n🧪 pi-agent-service unit tests\n");

  await testSettings();
  await testTrace();
  await testRouter();
  await testHealthCutoff();
  testSubscriptions();
  await testPromptAndTools();

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main();
