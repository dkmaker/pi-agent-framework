/**
 * E2E Test: Spawn alice + bob, have them communicate.
 *
 * - Alice: general purpose agent
 * - Bob: has web-search extension
 * - Manager sends a message to alice, alice talks to bob, bob searches
 *
 * Usage: npx tsx test/e2e-alice-bob.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { AgentManager } from "../src/manager.js";

const PROJECT_ROOT = `/tmp/pi-e2e-${Date.now()}`;

async function setup(): Promise<AgentManager> {
  fs.mkdirSync(PROJECT_ROOT, { recursive: true });
  console.log(`Project root: ${PROJECT_ROOT}\n`);

  // Write settings
  const settingsDir = path.join(PROJECT_ROOT, ".pi", "agents");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, "settings.json"),
    JSON.stringify(
      {
        service: {
          socket_path: `${PROJECT_ROOT}/service.sock`,
          pid_file: `${PROJECT_ROOT}/service.pid`,
          trace_file: `${PROJECT_ROOT}/trace.jsonl`,
        },
        acl: [
          { from: "alice", to: ["bob", "manager"] },
          { from: "bob", to: ["alice", "manager"] },
        ],
        agents: ["agents/alice", "agents/bob"],
      },
      null,
      2,
    ),
  );

  // Alice — general purpose
  const aliceDir = path.join(PROJECT_ROOT, "agents", "alice");
  fs.mkdirSync(aliceDir, { recursive: true });
  fs.writeFileSync(
    path.join(aliceDir, "agent.json"),
    JSON.stringify(
      {
        name: "alice",
        brief: "General purpose agent. Coordinates with bob for research tasks.",
        coding_tools: false,
        extensions: [],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(aliceDir, "SYSTEM.md"),
    `# Agent: Alice

You are Alice, a general purpose assistant agent.
When asked to research something, delegate to Bob using send_message.
When you receive research results from Bob, summarize them and send to the manager.
Be concise — keep messages under 200 words.`,
  );

  // Bob — has web-search
  const bobDir = path.join(PROJECT_ROOT, "agents", "bob");
  fs.mkdirSync(bobDir, { recursive: true });
  fs.writeFileSync(
    path.join(bobDir, "agent.json"),
    JSON.stringify(
      {
        name: "bob",
        brief: "Research agent with web search capabilities.",
        coding_tools: false,
        extensions: ["web-search"],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(bobDir, "SYSTEM.md"),
    `# Agent: Bob

You are Bob, a research agent with web search capabilities.
When you receive a research request, use the web_search tool to find information.
Send your findings back to the requester via send_message.
Be concise — keep messages under 200 words.`,
  );

  // Create manager
  const manager = await AgentManager.create({ projectRoot: PROJECT_ROOT });
  console.log("✓ Service created\n");
  return manager;
}

async function run() {
  console.log("🧪 E2E Test: Alice + Bob\n");

  const manager = await setup();

  // Spawn both agents
  console.log("▸ Spawning alice...");
  await manager.spawnAgent("alice");
  console.log("  ✓ Alice spawned");

  console.log("▸ Spawning bob...");
  await manager.spawnAgent("bob");
  console.log("  ✓ Bob spawned\n");

  // List agents
  const agents = manager.listAgents();
  console.log("▸ Agents:", agents.map((a) => `${a.name} (${a.status})`).join(", "));

  // Subscribe to all events for logging
  manager.subscribe({ types: ["message", "agent_state"] }, 100);
  manager.onSubscriptionEvent((event) => {
    const e = event.entry;
    if (e.type === "message") {
      console.log(`  📨 ${(e as any).from} → ${(e as any).to}: ${(e as any).subject}`);
    } else if (e.type === "agent_state") {
      console.log(`  🔄 ${(e as any).agent}: ${(e as any).from} → ${(e as any).to}`);
    }
  });

  // Send initial message to Alice
  console.log("\n▸ Sending message to Alice...");
  const result = await manager.sendMessage({
    from: "manager",
    to: "alice",
    subject: "Research request",
    body: "Please ask Bob to research: What is the current population of Tokyo? Send me a summary when you get the answer.",
  });
  console.log(`  ✓ Message sent (${result.status}), thread: ${result.threadId}\n`);

  // Wait and poll for activity
  console.log("▸ Waiting for agents to communicate (max 120s)...\n");

  const startTime = Date.now();
  const maxWait = 120_000;
  let lastTraceCount = 0;

  while (Date.now() - startTime < maxWait) {
    await sleep(5000);

    // Check trace for new entries
    const entries = manager.queryTrace({ limit: 500 });
    if (entries.length > lastTraceCount) {
      for (let i = lastTraceCount; i < entries.length; i++) {
        const e = entries[i];
        if (e.type === "message") {
          const msg = e as any;
          console.log(`  📨 [${elapsed(startTime)}] ${msg.from} → ${msg.to}: "${msg.subject}" (${msg.status})`);
        }
      }
      lastTraceCount = entries.length;
    }

    // Check if both agents are idle with no queued messages
    const aliceState = manager.getAgentState("alice");
    const bobState = manager.getAgentState("bob");

    if (
      aliceState.status === "online-idle" &&
      bobState.status === "online-idle" &&
      aliceState.messageStats.unread === 0 &&
      bobState.messageStats.unread === 0
    ) {
      // Check if we've seen messages from both agents
      const messages = entries.filter((e) => e.type === "message");
      const aliceSent = messages.some((m) => (m as any).from === "alice");
      const bobSent = messages.some((m) => (m as any).from === "bob");

      if (aliceSent && bobSent) {
        console.log(`\n  ✓ Both agents communicated! (${elapsed(startTime)})`);
        break;
      }
    }

    console.log(`  ⏳ [${elapsed(startTime)}] alice=${aliceState.status} bob=${bobState.status}`);
  }

  // Print final trace summary
  console.log("\n▸ Trace summary:");
  const allEntries = manager.queryTrace({ type: "message", limit: 100 });
  for (const e of allEntries) {
    const msg = e as any;
    const bodyPreview = msg.body?.slice(0, 80) ?? "";
    console.log(`  ${msg.from} → ${msg.to}: "${msg.subject}" | ${bodyPreview}...`);
  }

  // Print agent stats
  console.log("\n▸ Agent stats:");
  for (const name of ["alice", "bob"]) {
    const state = manager.getAgentState(name);
    console.log(
      `  ${name}: context=${state.contextPercent}% tokens=${state.tokensUsed} cost=$${state.cost.toFixed(4)}`,
    );
  }

  // Shutdown
  console.log("\n▸ Shutting down...");
  await manager.shutdown();
  console.log("  ✓ Done\n");

  // Cleanup
  fs.rmSync(PROJECT_ROOT, { recursive: true });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsed(start: number): string {
  const s = Math.round((Date.now() - start) / 1000);
  return `${s}s`;
}

run().catch((err) => {
  console.error(`\n💥 Fatal: ${err}\n${err.stack}`);
  process.exit(1);
});
