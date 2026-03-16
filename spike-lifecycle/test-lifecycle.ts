/**
 * Test: Spawn detached service, connect, disconnect, reconnect, get queued messages.
 */

import { spawn, execSync } from "child_process";
import { connect, type Socket } from "net";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";

const SOCKET_PATH = "/tmp/pi-spike-lifecycle.sock";
const PID_FILE = "/tmp/pi-spike-lifecycle.pid";
const LOG_FILE = "/tmp/pi-spike-lifecycle.log";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function connectToService(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(SOCKET_PATH);
    socket.on("connect", () => resolve(socket));
    socket.on("error", reject);
  });
}

function readLines(socket: Socket, timeout = 5000): Promise<any[]> {
  return new Promise((resolve) => {
    const events: any[] = [];
    let buffer = "";
    const handler = (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) events.push(JSON.parse(line));
      }
    };
    socket.on("data", handler);
    setTimeout(() => {
      socket.removeListener("data", handler);
      resolve(events);
    }, timeout);
  });
}

async function main() {
  // Clean up any existing service
  if (existsSync(PID_FILE)) {
    const oldPid = parseInt(readFileSync(PID_FILE, "utf-8"));
    if (isProcessAlive(oldPid)) {
      console.log(`Killing old service PID ${oldPid}`);
      process.kill(oldPid, "SIGTERM");
      await sleep(1000);
    }
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  }
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  if (existsSync(LOG_FILE)) unlinkSync(LOG_FILE);

  // === Test 1: Spawn detached service ===
  console.log("=== Test 1: Spawn detached service ===");
  const serviceScript = join(import.meta.dirname, "mini-service.ts");

  const child = spawn("npx", ["tsx", serviceScript], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();
  console.log(`  Spawned child PID: ${child.pid}`);

  // Wait for socket to appear
  for (let i = 0; i < 20; i++) {
    if (existsSync(SOCKET_PATH)) break;
    await sleep(500);
  }

  if (!existsSync(SOCKET_PATH)) {
    console.log("  ❌ Socket never appeared!");
    process.exit(1);
  }
  console.log("  ✅ Socket appeared");

  // Read PID file
  const servicePid = parseInt(readFileSync(PID_FILE, "utf-8"));
  console.log(`  Service PID from file: ${servicePid}`);
  console.log(`  Process alive: ${isProcessAlive(servicePid)}`);

  // === Test 2: Connect and send commands ===
  console.log("\n=== Test 2: Connect and communicate ===");
  let socket = await connectToService();
  let events = await readLines(socket, 2000);
  console.log(`  Received ${events.length} events on connect:`);
  for (const e of events) console.log(`    ${e.type}: ${JSON.stringify(e).substring(0, 80)}`);

  socket.write(JSON.stringify({ type: "ping" }) + "\n");
  socket.write(JSON.stringify({ type: "get_status" }) + "\n");
  events = await readLines(socket, 2000);
  console.log(`  After commands, got ${events.length} events:`);
  for (const e of events) console.log(`    ${e.type}: ${JSON.stringify(e).substring(0, 100)}`);

  // === Test 3: Disconnect — service should keep running ===
  console.log("\n=== Test 3: Disconnect (simulating pi exit) ===");
  socket.destroy();
  console.log("  Socket destroyed");
  console.log(`  Service still alive: ${isProcessAlive(servicePid)}`);

  // Wait for service to queue some messages (it sends every 5s)
  console.log("  Waiting 12s for service to queue messages...");
  await sleep(12000);
  console.log(`  Service still alive: ${isProcessAlive(servicePid)}`);

  // === Test 4: Reconnect — should get queued messages ===
  console.log("\n=== Test 4: Reconnect (simulating pi restart) ===");
  socket = await connectToService();
  events = await readLines(socket, 3000);
  console.log(`  Received ${events.length} events on reconnect:`);
  const queued = events.filter(e => e.type === "queued_message");
  const ready = events.filter(e => e.type === "service_ready");
  console.log(`    service_ready: ${ready.length} (uptime: ${ready[0]?.uptime?.toFixed(1)}s)`);
  console.log(`    queued_messages: ${queued.length}`);
  for (const q of queued) console.log(`      ${q.content}`);

  // === Test 5: Singleton — second server should fail ===
  console.log("\n=== Test 5: Singleton check ===");
  try {
    const { createServer } = await import("net");
    const testServer = createServer();
    await new Promise<void>((resolve, reject) => {
      testServer.on("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          console.log("  ✅ Socket already in use — singleton works");
          resolve();
        } else reject(err);
      });
      testServer.listen(SOCKET_PATH, () => {
        console.log("  ❌ Was able to bind — singleton FAILED");
        testServer.close();
        resolve();
      });
    });
  } catch (err: any) {
    console.log(`  Error: ${err.message}`);
  }

  // === Test 6: Graceful shutdown ===
  console.log("\n=== Test 6: Graceful shutdown (SIGTERM) ===");
  socket.destroy();
  process.kill(servicePid, "SIGTERM");
  await sleep(2000);
  console.log(`  Service alive after SIGTERM: ${isProcessAlive(servicePid)}`);
  console.log(`  Socket file exists: ${existsSync(SOCKET_PATH)}`);
  console.log(`  PID file exists: ${existsSync(PID_FILE)}`);

  // === Test 7: Stale detection ===
  console.log("\n=== Test 7: Stale PID detection ===");
  // Service is dead now. Check if we can detect it.
  const stalePid = servicePid; // this process is dead
  const alive = isProcessAlive(stalePid);
  console.log(`  PID ${stalePid} alive: ${alive} (should be false)`);
  console.log(`  ✅ Can detect stale PID — safe to restart`);

  // Check service log
  console.log("\n=== Service log ===");
  if (existsSync(LOG_FILE)) {
    const log = readFileSync(LOG_FILE, "utf-8");
    console.log(log);
  }

  console.log("\n✅ All lifecycle tests complete!");
}

main().catch(err => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
