/**
 * Quick test client — connects to the service, spawns 2 agents, sends a message, checks status.
 */

import { connect } from "net";
import { SOCKET_PATH, encode, createLineParser, type Command, type ServiceEvent } from "./protocol.js";

const socket = connect(SOCKET_PATH);
const events: ServiceEvent[] = [];

const parse = createLineParser((line) => {
  const event = JSON.parse(line) as ServiceEvent;
  events.push(event);
  console.log("📩 Event:", JSON.stringify(event).substring(0, 200));

  if (event.type === "agent_message") {
    console.log(`\n💬 MESSAGE from ${event.from} → ${event.to}:\n${event.content}\n`);
  }
});

socket.on("data", (chunk) => parse(chunk.toString()));

function send(cmd: Command) {
  console.log("📤 Command:", cmd.type, "name" in cmd ? cmd.name : "");
  socket.write(encode(cmd));
}

socket.on("connect", async () => {
  console.log("Connected!\n");

  // Wait for service_ready
  await sleep(500);

  // Spawn Alice
  send({
    type: "spawn_agent",
    name: "alice",
    systemPrompt: "You are Alice, a helpful assistant. When you receive messages, reply using send_message. Keep replies to 1 sentence.",
  });
  await sleep(3000);

  // Spawn Bob
  send({
    type: "spawn_agent",
    name: "bob",
    systemPrompt: "You are Bob, a grumpy developer. When you receive messages, reply using send_message. Keep replies to 1 sentence. Be grumpy.",
  });
  await sleep(3000);

  // Manager sends message to Alice
  send({ type: "send_message", from: "manager", to: "alice", content: "Hello Alice! Please say hi to Bob for me." });
  await sleep(10000);

  // Check status
  send({ type: "get_status" });
  await sleep(2000);

  // Check for any messages back to manager
  console.log("\n=== All events received ===");
  for (const e of events) {
    console.log(`  ${e.type}${("name" in e) ? `: ${e.name}` : ""}`);
  }

  socket.destroy();
  process.exit(0);
});

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
