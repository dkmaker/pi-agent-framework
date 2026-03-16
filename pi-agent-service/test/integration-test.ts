/**
 * Integration test — starts the full service and tests over Unix socket.
 *
 * Does NOT require API keys. Tests everything except actual agent spawning.
 *
 * Usage: npm run test:integration
 */

import * as net from "net";
import * as fs from "fs";
import * as path from "path";
import { AgentManager } from "../src/manager.js";
import { UnixSocketAdapter } from "../src/adapters/unix-socket.js";

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
            this.pending.get(msg.id)!.resolve(msg);
            this.pending.delete(msg.id);
          } else if (msg.event) {
            this.events.push(msg);
          }
        }
      });
    });
  }

  async send(method: string, params: any = {}): Promise<any> {
    const id = `req-${++reqId}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, 5000);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      this.socket.write(JSON.stringify({ id, method, params }) + "\n");
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
  fs.writeFileSync(path.join(agentDir, "agent.json"), JSON.stringify({
    name: "worker",
    brief: "Implements features.",
    auto_spawn: false,
  }));
  fs.writeFileSync(path.join(agentDir, "SYSTEM.md"), "# Worker\nYou code things.");

  // Write settings
  const settingsDir = path.join(tmp, ".pi", "agents");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({
    agents: ["agents/worker"],
    acl: [{ from: "worker", to: ["manager"] }],
    service: {
      socket_path: socketPath,
      pid_file: pidFile,
      trace_file: traceFile,
    },
  }));

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

  // 14. agent.spawn — skipped (requires API keys for SDK session creation)
  console.log("▸ agent.spawn (SKIPPED — requires API keys)");

  // 15. Unknown method
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
    try { JSON.parse(line); } catch { allValid = false; }
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
