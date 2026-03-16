/**
 * Test: Message queue, threading, priority, state tracking, trace log.
 *
 * 1. Spawn Alice and Bob
 * 2. Manager sends message to Alice
 * 3. Alice replies to manager AND forwards to Bob
 * 4. Bob replies to Alice
 * 5. Check: queues, threads, state transitions, trace log
 * 6. Test: important message interruption
 * 7. Test: thread exhaustion (loop protection)
 * 8. Test: online-only delivery to offline agent
 */

import { join } from "path";
import { unlinkSync, existsSync } from "fs";
import { AgentManager } from "./agent-manager.js";

const TRACE_FILE = join(import.meta.dirname, "test-trace.jsonl");
if (existsSync(TRACE_FILE)) unlinkSync(TRACE_FILE);

async function main() {
  console.log("🧪 Test: Message Queue, Threading & Agent State\n");

  const mgr = new AgentManager(TRACE_FILE);

  // Collect events
  const events: any[] = [];
  mgr.subscribe((event) => {
    events.push(event);
    if (event.type === "agent_state_change") {
      console.log(`  📊 ${event.name}: ${event.state} (${event.reason})`);
    }
    if (event.type === "agent_message") {
      console.log(`  💬 Message to manager from ${event.message.from}: ${event.message.body.substring(0, 60)}...`);
    }
  });

  // --- Test 1: Spawn agents ---
  console.log("=== Test 1: Spawn agents ===");
  await mgr.spawnAgent("alice", `You are Alice. When you get a message, reply to the sender using send_message with a short response. Also forward interesting messages to bob. Keep all messages to 1 sentence.`);
  await mgr.spawnAgent("bob", `You are Bob, grumpy but helpful. Reply to messages using send_message. Keep replies to 1 sentence.`);
  console.log(`  Agents: ${mgr.getAgentNames().join(", ")}`);

  // --- Test 2: Manager sends message, check queue ---
  console.log("\n=== Test 2: Manager → Alice (via queue) ===");
  const r1 = mgr.sendMessage("manager", "alice", "Greeting", "Hello Alice! What's your favorite programming language?");
  console.log(`  Sent: ${JSON.stringify(r1.message?.id?.substring(0, 8))}, status: ${r1.message?.status}`);
  console.log(`  Alice queue depth: ${mgr.queue.queueDepth("alice")}`);

  // Wait for delivery + response
  console.log("  Waiting for delivery and responses...");
  await sleep(15000);

  // --- Test 3: Check status ---
  console.log("\n=== Test 3: Agent status ===");
  const status = mgr.getAllStatus();
  for (const [name, s] of Object.entries(status)) {
    console.log(`  ${name}: state=${s.state}, context=${s.contextPercent.toFixed(1)}%, msgs(sent=${s.messageStats.sent}, recv=${s.messageStats.received}, queued=${s.messageStats.queued}), health=${s.health}`);
  }

  // --- Test 4: Check threads ---
  console.log("\n=== Test 4: Threads ===");
  const threads = mgr.queue.listThreads();
  for (const t of threads) {
    console.log(`  Thread ${t.id.substring(0, 20)}...: "${t.subject}" (${t.messageCount} msgs, participants: ${t.participants.join(", ")})`);
  }

  // --- Test 5: online-only to offline agent ---
  console.log("\n=== Test 5: Online-only to offline agent ===");
  const r2 = mgr.sendMessage("manager", "charlie", "Test", "Are you there?", { delivery: "online-only" });
  console.log(`  Result: status=${r2.message?.status}`); // should be "failed"

  // --- Test 6: Thread exhaustion ---
  console.log("\n=== Test 6: Thread exhaustion (loop protection) ===");
  const threadId = "test-exhaust";
  for (let i = 0; i < 101; i++) {
    const r = mgr.sendMessage("manager", "alice", "Spam", `Message ${i}`, { threadId });
    if ("error" in r) {
      console.log(`  Blocked at message ${i}: ${r.error}`);
      break;
    }
  }

  // --- Test 7: Check trace log ---
  console.log("\n=== Test 7: Trace log ===");
  const traceEntries = mgr.trace.replay();
  const typeCounts: Record<string, number> = {};
  for (const e of traceEntries) {
    typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
  }
  console.log(`  Total entries: ${traceEntries.length}`);
  for (const [type, count] of Object.entries(typeCounts).sort()) {
    console.log(`    ${type}: ${count}`);
  }

  // --- Test 8: Event summary ---
  console.log("\n=== Test 8: Events received ===");
  const eventCounts: Record<string, number> = {};
  for (const e of events) {
    eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
  }
  for (const [type, count] of Object.entries(eventCounts).sort()) {
    console.log(`  ${type}: ${count}`);
  }

  // Cleanup
  console.log("\n🧹 Cleanup...");
  mgr.dispose();
  console.log("✅ Done!");
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
