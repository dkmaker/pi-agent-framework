/**
 * Unix socket adapter — NDJSON protocol over Unix domain socket.
 *
 * Manager extension is client; agent service is server.
 * Each JSON message is one line terminated by \n.
 *
 * Reference: asset [4o3g4qf3]
 */

import * as net from "net";
import * as fs from "fs";
import type { AgentManager } from "../manager.js";
import type {
  ProtocolRequest,
  ProtocolResponse,
  ProtocolEvent,
  ProtocolErrorCode,
} from "../types.js";

export class UnixSocketAdapter {
  private server: net.Server | null = null;
  private clients: Set<net.Socket> = new Set();
  private unsubscribers: Array<() => void> = [];

  constructor(
    private manager: AgentManager,
    private socketPath: string,
  ) {}

  /**
   * Start the socket server.
   */
  async start(): Promise<void> {
    // Clean up stale socket file
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // Doesn't exist — fine
    }

    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    return new Promise((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(this.socketPath, () => {
        resolve();
      });
    });
  }

  /**
   * Stop the socket server.
   */
  async stop(): Promise<void> {
    // Unsubscribe from manager events
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    // Close all client connections
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();

    // Close server
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          // Clean up socket file
          try {
            fs.unlinkSync(this.socketPath);
          } catch { /* ignore */ }
          resolve();
        });
      });
    }
  }

  // ─── Connection Handling ──────────────────────────────────────

  private handleConnection(socket: net.Socket): void {
    this.clients.add(socket);

    // Wire subscription events to this client
    const unsub = this.manager.onSubscriptionEvent((event) => {
      this.pushEvent(socket, {
        event: event.entry.type,
        data: {
          ...event.entry,
          subscription_expired: event.subscriptionExpired || undefined,
        },
      });
    });
    this.unsubscribers.push(unsub);

    let buffer = "";

    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleLine(socket, line);
      }
    });

    socket.on("close", () => {
      this.clients.delete(socket);
      unsub();
      // Cancel subscriptions on disconnect
      this.manager.subscriptions.cancelAll();
    });

    socket.on("error", () => {
      this.clients.delete(socket);
    });
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let req: ProtocolRequest;
    try {
      req = JSON.parse(line);
    } catch {
      return; // skip malformed
    }

    try {
      const result = await this.dispatch(req.method, req.params ?? {});
      this.send(socket, { id: req.id, result });
    } catch (err: any) {
      const code: ProtocolErrorCode = err.code ?? "INTERNAL";
      this.send(socket, {
        id: req.id,
        error: { code, message: err.message },
      });
    }
  }

  // ─── Command Dispatch ─────────────────────────────────────────

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      // Agent Lifecycle
      case "agent.spawn":
        await this.manager.spawnAgent(params.name as string);
        return { status: "ok" };

      case "agent.stop":
        await this.manager.stopAgent(params.name as string);
        return { status: "ok" };

      case "agent.restart":
        await this.manager.restartAgent(params.name as string, params.prompt as string | undefined);
        return { status: "ok" };

      case "agent.compact":
        await this.manager.compactAgent(params.name as string);
        return { status: "ok" };

      // Agent State
      case "agent.status":
        return this.manager.getAgentState(params.name as string);

      case "agent.list":
        return this.manager.listAgents();

      case "agent.config":
        return this.manager.getAgentConfig(params.name as string);

      case "agent.peek":
        // TODO: implement peek (agent output capture)
        return { output: "" };

      // Messaging
      case "message.send":
        return this.manager.sendMessage({
          from: params.from as string,
          to: params.to as string,
          subject: params.subject as string,
          body: params.body as string,
          threadId: params.threadId as string | undefined,
          replyTo: params.replyTo as string | undefined,
          priority: (params.priority as "normal" | "important") ?? "normal",
          delivery: (params.delivery as "persist" | "online-only") ?? "persist",
        });

      case "message.list":
        return this.manager.getMessages({
          agent: params.agent as string | undefined,
          threadId: params.threadId as string | undefined,
          limit: params.limit as number | undefined,
          before: params.before as string | undefined,
        });

      case "thread.list":
        return this.manager.getThreads({
          agent: params.agent as string | undefined,
        });

      // Subscriptions
      case "subscribe":
        return {
          subscriptionId: this.manager.subscribe(
            params.filter as any,
            params.maxEvents as number,
          ),
        };

      case "unsubscribe":
        this.manager.unsubscribe(params.subscriptionId as string);
        return { status: "ok" };

      // Trace
      case "trace.query":
        return this.manager.queryTrace(params as any);

      // Configuration
      case "config.reload":
        await this.manager.reloadSettings();
        return { status: "ok" };

      case "config.show":
        return this.manager.getSettings();

      case "acl.update":
        await this.manager.updateAcl(params.acl as any);
        return { status: "ok" };

      // Agent Registration (delegated to settings)
      case "agent.register":
        // TODO: implement full registration logic
        return { status: "ok" };

      case "agent.unregister":
        // TODO: implement unregistration
        return { status: "ok" };

      // Service
      case "service.ping":
        return {
          status: "ok",
          uptime: this.manager.uptime,
          agents: this.manager.agentCount,
        };

      case "service.shutdown":
        // Schedule shutdown after response
        setTimeout(() => this.manager.shutdown(), 100);
        return { status: "ok" };

      default:
        throw { code: "INVALID_PARAMS", message: `Unknown method: ${method}` };
    }
  }

  // ─── Wire Helpers ─────────────────────────────────────────────

  private send(socket: net.Socket, response: ProtocolResponse): void {
    try {
      socket.write(JSON.stringify(response) + "\n");
    } catch {
      // Client disconnected
    }
  }

  private pushEvent(socket: net.Socket, event: ProtocolEvent): void {
    try {
      socket.write(JSON.stringify(event) + "\n");
    } catch {
      // Client disconnected
    }
  }
}
