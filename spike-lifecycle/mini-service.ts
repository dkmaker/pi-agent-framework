/**
 * Mini service — tests detached lifecycle, PID file, singleton, reconnect.
 * No SDK — just socket + PID + message queue.
 */

import { createServer, type Socket } from "net";
import { writeFileSync, unlinkSync, existsSync, readFileSync, appendFileSync } from "fs";

const SOCKET_PATH = "/tmp/pi-spike-lifecycle.sock";
const PID_FILE = "/tmp/pi-spike-lifecycle.pid";
const LOG_FILE = "/tmp/pi-spike-lifecycle.log";

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + "\n");
}

// Cleanup stale socket
if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);

// Write PID file
writeFileSync(PID_FILE, String(process.pid));
log(`Service started. PID=${process.pid}`);

// Message queue for disconnected clients
const managerQueue: string[] = [];
let clientSocket: Socket | null = null;
let messageCounter = 0;

const server = createServer((socket) => {
  log("Client connected");
  clientSocket = socket;

  // Flush queued messages
  if (managerQueue.length > 0) {
    log(`Flushing ${managerQueue.length} queued messages`);
    for (const msg of managerQueue) {
      socket.write(JSON.stringify({ type: "queued_message", content: msg }) + "\n");
    }
    managerQueue.length = 0;
  }

  socket.write(JSON.stringify({ type: "service_ready", pid: process.pid, uptime: process.uptime() }) + "\n");

  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const cmd = JSON.parse(line);
        handleCommand(cmd, socket);
      } catch {}
    }
  });

  socket.on("close", () => {
    log("Client disconnected");
    clientSocket = null;
  });

  socket.on("error", () => {
    clientSocket = null;
  });
});

function handleCommand(cmd: any, socket: Socket) {
  if (cmd.type === "ping") {
    socket.write(JSON.stringify({ type: "pong", counter: ++messageCounter }) + "\n");
    log(`Ping → Pong #${messageCounter}`);
  }
  if (cmd.type === "get_status") {
    socket.write(JSON.stringify({
      type: "status",
      pid: process.pid,
      uptime: process.uptime(),
      messageCounter,
      queuedForManager: managerQueue.length,
    }) + "\n");
  }
  if (cmd.type === "stop") {
    log("Stop requested");
    cleanup();
    process.exit(0);
  }
}

// Simulate agent sending a message every 5s (even when no client connected)
setInterval(() => {
  const msg = `Agent report #${++messageCounter} at ${new Date().toISOString()}`;
  if (clientSocket && !clientSocket.destroyed) {
    clientSocket.write(JSON.stringify({ type: "agent_message", content: msg }) + "\n");
    log(`Sent message to client: ${msg}`);
  } else {
    managerQueue.push(msg);
    log(`Queued (no client): ${msg}`);
  }
}, 5000);

function cleanup() {
  log("Cleaning up...");
  server.close();
  if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
  if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
}

server.listen(SOCKET_PATH, () => {
  log(`Listening on ${SOCKET_PATH}`);
});

process.on("SIGTERM", () => { log("SIGTERM received"); cleanup(); process.exit(0); });
process.on("SIGINT", () => { log("SIGINT received"); cleanup(); process.exit(0); });
