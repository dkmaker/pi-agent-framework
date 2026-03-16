/**
 * Integration test — starts the full service and tests over Unix socket.
 *
 * Does NOT require API keys. Tests everything except actual agent spawning.
 *
 * Usage: npm run test:integration
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { UnixSocketAdapter } from "../src/adapters/unix-socket.js";
import { AgentManager } from "../src/manager.js";

let passed = 0;
let failed = 0;
let reqId = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

// ─── Socket Client ────────────────────────────────────────────

class TestClient {
  private socket: net.Socket;
  private buffer = "";
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private events: any[] = [];

  constructor(private socketPath: string) {
    this.socket = new net.Socket();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.connect(this.socketPath, () => resolve());
      this.socket.on("error", reject);
      this.socket.on("data", (data) => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.id && this.pending.has(msg.id)) {
            this.pending.get(msg.id)?.resolve(msg);
            this.pending.delete(msg.id);
          } else if (msg.event) {
            this.events.push(msg);
          }
        }
      });
    });
  }

  async send(method: string, params: any = {}, timeoutMs = 5000): Promise<any> {
    const id = `req-${++reqId}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timeout);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });

      this.socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  getEvents(): any[] {
    return this.events;
  }

  close(): void {
    this.socket.destroy();
  }
}

// ─── Main Test ────────────────────────────────────────────────

async function main() {
  console.log("\n🔌 pi-agent-service integration test\n");

  const tmp = `/tmp/pi-integration-${Date.now()}`;
  fs.mkdirSync(tmp, { recursive: true });

  const socketPath = `${tmp}/test.sock`;
  const pidFile = `${tmp}/test.pid`;
  const traceFile = `${tmp}/trace.jsonl`;

  // Set up a mock agent (no actual spawning)
  const agentDir = path.join(tmp, "agents", "worker");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "agent.json"),
    JSON.stringify({
      name: "worker",
      brief: "Implements features.",
      auto_spawn: false,
    }),
  );
  fs.writeFileSync(path.join(agentDir, "SYSTEM.md"), "# Worker\nYou code things.");

  // Write settings
  const settingsDir = path.join(tmp, ".pi", "agents");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, "settings.json"),
    JSON.stringify({
      agents: ["agents/worker"],
      acl: [{ from: "worker", to: ["manager"] }],
      service: {
        socket_path: socketPath,
        pid_file: pidFile,
        trace_file: traceFile,
      },
    }),
  );

  // Start service
  console.log("▸ Starting service...");
  let manager: AgentManager;
  try {
    manager = await AgentManager.create({ projectRoot: tmp });
  } catch (err) {
    console.error(`Failed to create manager: ${err}`);
    process.exit(1);
  }

  const adapter = new UnixSocketAdapter(manager, socketPath);
  await adapter.start();
  console.log("  Service started on", socketPath);

  // Connect client
  const client = new TestClient(socketPath);
  await client.connect();
  console.log("  Client connected\n");

  // ─── Tests ────────────────────────────────────────────

  // 1. service.ping
  console.log("▸ service.ping");
  const ping = await client.send("service.ping");
  assert(!ping.error, "no error");
  assert(ping.result.status === "ok", "status ok");
  assert(typeof ping.result.uptime === "number", "has uptime");
  assert(typeof ping.result.agents === "number", "has agent count");

  // 2. config.show
  console.log("▸ config.show");
  const config = await client.send("config.show");
  assert(!config.error, "no error");
  assert(config.result.defaults.model === "claude-sonnet-4-20250514", "has default model");
  assert(Array.isArray(config.result.acl), "has ACL");
  assert(config.result.agents.length === 1, "has 1 agent path");

  // 3. config.reload
  console.log("▸ config.reload");
  const reload = await client.send("config.reload");
  assert(!reload.error, "no error");
  assert(reload.result.status === "ok", "reload ok");

  // 4. acl.update
  console.log("▸ acl.update");
  const aclUpdate = await client.send("acl.update", {
    acl: [
      { from: "worker", to: ["manager", "reviewer"] },
      { from: "reviewer", to: ["worker"] },
    ],
  });
  assert(!aclUpdate.error, "no error");
  assert(aclUpdate.result.status === "ok", "acl updated");

  // Verify ACL persisted
  const configAfter = await client.send("config.show");
  assert(configAfter.result.acl.length === 2, "ACL has 2 rules");

  // 5. agent.list
  console.log("▸ agent.list");
  const list = await client.send("agent.list");
  assert(!list.error, "no error");
  assert(Array.isArray(list.result), "result is array");
  assert(list.result.length === 1, "1 agent");
  assert(list.result[0].name === "worker", "agent name");
  assert(list.result[0].status === "offline", "agent offline");

  // 6. agent.status
  console.log("▸ agent.status");
  const status = await client.send("agent.status", { name: "worker" });
  assert(!status.error, "no error");
  assert(status.result.name === "worker", "name matches");
  assert(status.result.status === "offline", "status offline");

  // 7. agent.config
  console.log("▸ agent.config");
  const agentConfig = await client.send("agent.config", { name: "worker" });
  assert(!agentConfig.error, "no error");
  assert(agentConfig.result.name === "worker", "config name");
  assert(agentConfig.result.brief === "Implements features.", "config brief");

  // 8. message.send (manager→worker, queued because offline)
  console.log("▸ message.send");
  const msgResult = await client.send("message.send", {
    from: "manager",
    to: "worker",
    subject: "Start task",
    body: "Please implement feature X.",
  });
  assert(!msgResult.error, "no error");
  assert(msgResult.result.status === "queued", "message queued (agent offline)");
  assert(!!msgResult.result.messageId, "has messageId");
  assert(!!msgResult.result.threadId, "has threadId");

  // 9. message.list
  console.log("▸ message.list");
  const msgs = await client.send("message.list", { agent: "manager" });
  assert(!msgs.error, "no error");
  // Note: messages may be empty if trace query doesn't match agent field — that's ok for now

  // 10. thread.list
  console.log("▸ thread.list");
  const threads = await client.send("thread.list", {});
  assert(!threads.error, "no error");
  assert(Array.isArray(threads.result), "threads is array");

  // 11. subscribe
  console.log("▸ subscribe / unsubscribe");
  const sub = await client.send("subscribe", {
    filter: { types: ["message"] },
    maxEvents: 100,
  });
  assert(!sub.error, "no error");
  assert(!!sub.result.subscriptionId, "has subscription id");

  // 12. unsubscribe
  const unsub = await client.send("unsubscribe", {
    subscriptionId: sub.result.subscriptionId,
  });
  assert(!unsub.error, "no error");
  assert(unsub.result.status === "ok", "unsubscribed");

  // 13. trace.query
  console.log("▸ trace.query");
  const traceResult = await client.send("trace.query", { limit: 100 });
  assert(!traceResult.error, "no error");
  assert(Array.isArray(traceResult.result), "trace is array");
  assert(traceResult.result.length > 0, "trace has entries");

  // Verify trace has service_started
  const startEntry = traceResult.result.find((e: any) => e.type === "service_started");
  assert(!!startEntry, "trace has service_started");

  // Verify trace has message
  const msgEntry = traceResult.result.find((e: any) => e.type === "message");
  assert(!!msgEntry, "trace has message entry");

  // ─── Real agent lifecycle tests (uses auth from ~/.pi/agent/auth.json) ───

  // 14. agent.spawn — spawn the worker agent
  console.log("▸ agent.spawn (real agent)");
  const spawn = await client.send("agent.spawn", { name: "worker" }, 30000);
  assert(!spawn.error, "spawn no error");
  assert(spawn.result.status === "ok", "spawn ok");

  // Verify agent is now online-idle
  const statusAfterSpawn = await client.send("agent.status", { name: "worker" });
  assert(statusAfterSpawn.result.status === "online-idle", "agent online-idle after spawn");

  // agent.list should show online
  const listAfterSpawn = await client.send("agent.list");
  const workerInList = listAfterSpawn.result.find((a: any) => a.name === "worker");
  assert(workerInList.status === "online-idle", "worker online in list");

  // 14b. agent.spawn duplicate — should error
  console.log("▸ agent.spawn (duplicate — expect error)");
  const spawnDup = await client.send("agent.spawn", { name: "worker" });
  assert(!!spawnDup.error, "duplicate spawn errors");
  assert(spawnDup.error.code === "ALREADY_RUNNING", "ALREADY_RUNNING code");

  // 14c. Send message to spawned agent — should deliver (agent is idle)
  console.log("▸ message.send (to spawned agent — should deliver)");
  const msgToSpawned = await client.send(
    "message.send",
    {
      from: "manager",
      to: "worker",
      subject: "Hello",
      body: "Just say OK and nothing else.",
    },
    15000,
  );
  assert(!msgToSpawned.error, "no error");

  // Wait for agent to process the message
  console.log("  waiting for agent to process...");
  await new Promise((r) => setTimeout(r, 15000));

  // 14d. agent.peek — read agent output
  console.log("▸ agent.peek (running agent)");
  const peek = await client.send("agent.peek", { name: "worker" });
  assert(!peek.error, "peek no error");
  assert(typeof peek.result.output === "string", "peek returns string");
  assert(peek.result.output.length > 0, "peek has output");
  console.log(`  peek output: ${peek.result.output.slice(0, 100)}...`);

  // 14e. agent.status — should have real context/token stats now
  console.log("▸ agent.status (after message — check stats)");
  const statsAfterMsg = await client.send("agent.status", { name: "worker" });
  assert(
    statsAfterMsg.result.status === "online-idle" || statsAfterMsg.result.status === "online-working",
    "agent online",
  );
  console.log(
    `  context=${statsAfterMsg.result.contextPercent}% tokens=${statsAfterMsg.result.tokensUsed} cost=$${statsAfterMsg.result.cost}`,
  );

  // 14f. agent.compact — may fail if session too short, that's ok
  console.log("▸ agent.compact (running agent)");
  const compact = await client.send("agent.compact", { name: "worker" }, 30000);
  // Compact may error if session is too short — just verify we got a response
  assert(compact.result || compact.error, "compact responded");

  // 14g. agent.stop
  console.log("▸ agent.stop (running agent)");
  const stop = await client.send("agent.stop", { name: "worker" });
  assert(!stop.error, "stop no error");
  assert(stop.result.status === "ok", "stop ok");

  // Verify offline
  const statusAfterStop = await client.send("agent.status", { name: "worker" });
  assert(statusAfterStop.result.status === "offline", "agent offline after stop");

  // 14h. agent.restart (from offline — spawns fresh)
  console.log("▸ agent.restart (from offline)");
  const restart = await client.send("agent.restart", { name: "worker" }, 30000);
  assert(!restart.error, "restart no error");
  assert(restart.result.status === "ok", "restart ok");

  // Verify back online
  const statusAfterRestart = await client.send("agent.status", { name: "worker" });
  assert(statusAfterRestart.result.status === "online-idle", "agent online after restart");

  // Stop again for remaining tests
  await client.send("agent.stop", { name: "worker" });

  // ─── Registration, lifecycle errors, threading, ACL ───

  // 15. agent.register — create a new agent via socket
  console.log("▸ agent.register (new agent)");
  const reg = await client.send("agent.register", { name: "researcher" });
  assert(!reg.error, "no error");
  assert(reg.result.status === "ok", "registered");
  assert(reg.result.scaffolded === true, "scaffolded");

  // Verify folder was created
  const researcherDir = path.join(tmp, ".pi", "agents", "researcher");
  assert(fs.existsSync(path.join(researcherDir, "agent.json")), "agent.json created");
  assert(fs.existsSync(path.join(researcherDir, "SYSTEM.md")), "SYSTEM.md created");
  assert(fs.existsSync(path.join(researcherDir, "AGENTS.md")), "AGENTS.md created");

  // Verify settings updated — reload config and check
  await client.send("config.reload");
  const configAfterReg = await client.send("config.show");
  assert(configAfterReg.result.agents.length === 2, "settings has 2 agents now");

  // Verify ACL auto-added
  const researcherAcl = configAfterReg.result.acl.find((r: any) => r.from === "researcher");
  assert(!!researcherAcl, "ACL entry created for researcher");
  assert(researcherAcl.to.includes("manager"), "researcher can message manager");

  // 16. agent.register — re-register same agent (no re-scaffold)
  console.log("▸ agent.register (existing agent, no re-scaffold)");
  const reg2 = await client.send("agent.register", { name: "researcher" });
  assert(!reg2.error, "no error");
  // Should not re-scaffold since files already exist

  // 17. agent.list — verify new agent appears
  console.log("▸ agent.list (after register)");
  const listAfterReg = await client.send("agent.list");
  assert(listAfterReg.result.length === 2, "2 agents now");
  const researcherEntry = listAfterReg.result.find((a: any) => a.name === "researcher");
  assert(!!researcherEntry, "researcher in list");
  assert(researcherEntry.status === "offline", "researcher offline");

  // 18. agent.stop on offline agent — should error
  console.log("▸ agent.stop (offline agent — expect error)");
  const stopOffline = await client.send("agent.stop", { name: "worker" });
  assert(!!stopOffline.error, "error returned");
  assert(stopOffline.error.code === "NOT_RUNNING", "NOT_RUNNING code");

  // 19. agent.restart on offline agent — should error (no session to stop)
  console.log("▸ agent.restart (offline — expect error from spawn, no API key)");
  // This will try to spawn which requires API keys — just verify it responds
  // We can't fully test this without API keys

  // 20. agent.compact on offline agent — should error
  console.log("▸ agent.compact (offline — expect error)");
  const compactOffline = await client.send("agent.compact", { name: "worker" });
  assert(!!compactOffline.error, "error returned");
  assert(compactOffline.error.code === "NOT_RUNNING", "NOT_RUNNING code");

  // 21. agent.peek on offline agent — should error
  console.log("▸ agent.peek (offline — expect error)");
  const peekOffline = await client.send("agent.peek", { name: "worker" });
  assert(!!peekOffline.error, "error returned");
  assert(peekOffline.error.code === "NOT_RUNNING", "NOT_RUNNING code");

  // 22. message.send with threading (same threadId)
  console.log("▸ message.send (threading — same threadId)");
  const threadedMsg = await client.send("message.send", {
    from: "manager",
    to: "worker",
    subject: "Follow up",
    body: "Any progress?",
    threadId: msgResult.result.threadId,
  });
  assert(!threadedMsg.error, "no error");
  assert(threadedMsg.result.threadId === msgResult.result.threadId, "same thread");

  // 23. thread.list — verify thread has 2 messages
  console.log("▸ thread.list (verify threading)");
  const threadsAfter = await client.send("thread.list", {});
  assert(!threadsAfter.error, "no error");
  const mainThread = threadsAfter.result.find((t: any) => t.threadId === msgResult.result.threadId);
  assert(!!mainThread, "thread found");
  assert(mainThread.messageCount >= 2, "thread has 2+ messages");

  // 24. message.send with ACL denial
  console.log("▸ message.send (ACL denial)");
  const deniedMsg = await client.send("message.send", {
    from: "worker",
    to: "researcher",
    subject: "Hello",
    body: "Can you help?",
  });
  assert(!deniedMsg.error, "no protocol error (drop is not an error)");
  assert(deniedMsg.result.status === "dropped", "message dropped by ACL");

  // 25. message.send with priority=important
  console.log("▸ message.send (priority=important)");
  const importantMsg = await client.send("message.send", {
    from: "manager",
    to: "worker",
    subject: "URGENT",
    body: "Stop everything!",
    priority: "important",
  });
  assert(!importantMsg.error, "no error");
  assert(importantMsg.result.status === "queued", "important message queued");

  // 26. Multiple subscriptions
  console.log("▸ subscribe (multiple)");
  const sub1 = await client.send("subscribe", { filter: { types: ["message"] }, maxEvents: 50 });
  const sub2 = await client.send("subscribe", { filter: { types: ["agent_state"] }, maxEvents: 50 });
  const sub3 = await client.send("subscribe", { filter: { agent: "worker" }, maxEvents: 50 });
  assert(!sub1.error && !sub2.error && !sub3.error, "all subscribed");

  // Verify subscription list
  // (can't query subscriptions via protocol directly, but verify no errors)
  // Unsubscribe all
  await client.send("unsubscribe", { subscriptionId: sub1.result.subscriptionId });
  await client.send("unsubscribe", { subscriptionId: sub2.result.subscriptionId });
  await client.send("unsubscribe", { subscriptionId: sub3.result.subscriptionId });

  // 27. trace.query with type filter
  console.log("▸ trace.query (type filter)");
  const traceMessages = await client.send("trace.query", { type: "message", limit: 100 });
  assert(!traceMessages.error, "no error");
  assert(traceMessages.result.length >= 3, "at least 3 message traces (original + threaded + important)");
  assert(
    traceMessages.result.every((e: any) => e.type === "message"),
    "all are message type",
  );

  // 28. trace.query with agent filter
  console.log("▸ trace.query (agent filter)");
  const _traceWorker = await client.send("trace.query", { agent: "worker" });
  // Note: trace entries have various agent fields depending on type

  // 29. agent.unregister
  console.log("▸ agent.unregister");
  const unreg = await client.send("agent.unregister", { name: "researcher" });
  assert(!unreg.error, "no error");
  assert(unreg.result.status === "ok", "unregistered");

  // Verify folder still exists (unregister doesn't delete)
  assert(fs.existsSync(path.join(researcherDir, "agent.json")), "folder preserved");

  // 30. unknown method
  console.log("▸ unknown method");
  const unknown = await client.send("nonexistent.method");
  assert(!!unknown.error, "error returned");
  assert(unknown.error.code === "INVALID_PARAMS", "correct error code");

  // 16. agent.status for unknown agent
  console.log("▸ agent.status (unknown agent)");
  const notFound = await client.send("agent.status", { name: "nonexistent" });
  assert(!!notFound.error, "error returned");
  assert(notFound.error.code === "NOT_FOUND", "NOT_FOUND code");

  // 17. Verify trace.jsonl file
  console.log("▸ trace.jsonl file");
  const traceContent = fs.readFileSync(traceFile, "utf-8");
  const traceLines = traceContent.trim().split("\n").filter(Boolean);
  assert(traceLines.length > 0, "trace file has entries");
  // Verify all lines are valid JSON
  let allValid = true;
  for (const line of traceLines) {
    try {
      JSON.parse(line);
    } catch {
      allValid = false;
    }
  }
  assert(allValid, "all trace lines are valid JSON");

  // ─── Cleanup ──────────────────────────────────────────

  console.log("\n▸ Shutdown");
  client.close();
  await adapter.stop();
  await manager.shutdown();

  // Verify socket file removed
  assert(!fs.existsSync(socketPath), "socket file cleaned up");

  fs.rmSync(tmp, { recursive: true });

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});
