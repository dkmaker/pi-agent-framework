#!/usr/bin/env node
/**
 * pi-agent-service CLI entry point.
 *
 * Usage: pi-agent-service --project /path/to/project
 *
 * Starts the agent service as a standalone process:
 * - Loads settings from .pi/agents/settings.json
 * - Opens Unix socket for manager extension communication
 * - Manages SDK agent sessions
 * - Writes PID file for singleton enforcement
 * - Handles graceful shutdown on SIGTERM/SIGINT
 */

import * as fs from "fs";
import * as path from "path";
import { AgentManager } from "./manager.js";
import { UnixSocketAdapter } from "./adapters/unix-socket.js";

interface CliArgs {
  projectRoot: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let projectRoot: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) {
      projectRoot = args[i + 1];
      i++;
    }
  }

  if (!projectRoot) {
    console.error("Usage: pi-agent-service --project <path>");
    process.exit(1);
  }

  return { projectRoot: path.resolve(projectRoot) };
}

/**
 * Check if another instance is running via PID file.
 */
function checkSingleton(pidFile: string): void {
  try {
    const pidStr = fs.readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (!isNaN(pid)) {
      try {
        // Check if process is alive (signal 0 = no signal, just check)
        process.kill(pid, 0);
        console.error(`pi-agent-service already running (PID ${pid}). Exiting.`);
        process.exit(1);
      } catch {
        // Process not found — stale PID file, continue
        console.log(`Removing stale PID file (was PID ${pid})`);
        fs.unlinkSync(pidFile);
      }
    }
  } catch {
    // No PID file — fine
  }
}

/**
 * Write PID file.
 */
function writePidFile(pidFile: string): void {
  const dir = path.dirname(pidFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));
}

/**
 * Remove PID file.
 */
function removePidFile(pidFile: string): void {
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // Already gone
  }
}

async function main(): Promise<void> {
  const { projectRoot } = parseArgs();

  console.log(`pi-agent-service starting...`);
  console.log(`  project: ${projectRoot}`);
  console.log(`  pid: ${process.pid}`);

  // Create manager (loads settings, inits trace, recovers state)
  let manager: AgentManager;
  try {
    manager = await AgentManager.create({ projectRoot });
  } catch (err) {
    console.error(`Failed to initialize: ${err}`);
    process.exit(1);
  }

  const settings = manager.getSettings();
  const pidFile = path.isAbsolute(settings.service.pid_file)
    ? settings.service.pid_file
    : path.join(projectRoot, settings.service.pid_file);
  const socketPath = settings.service.socket_path;

  // Singleton check
  checkSingleton(pidFile);
  writePidFile(pidFile);

  // Start socket server
  const adapter = new UnixSocketAdapter(manager, socketPath);
  try {
    await adapter.start();
    console.log(`  socket: ${socketPath}`);
  } catch (err) {
    console.error(`Failed to start socket: ${err}`);
    removePidFile(pidFile);
    process.exit(1);
  }

  console.log(`pi-agent-service ready.`);

  // Graceful shutdown handler
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`\nReceived ${signal}. Shutting down...`);

    try {
      await adapter.stop();
    } catch {
      // Best effort
    }

    try {
      await manager.shutdown();
    } catch {
      // Best effort
    }

    removePidFile(pidFile);
    console.log("pi-agent-service stopped.");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Keep process alive
  // The socket server keeps the event loop running
}

main().catch((err) => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});
