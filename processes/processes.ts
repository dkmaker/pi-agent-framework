import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateTail } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn, execSync, ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// ── Safety: cap any text injected into conversation context ─────────────
const MAX_MSG_BYTES = 4096;
const MAX_LINE_CHARS = 500;
let _spillCounter = 0;

/** Cap text for context injection. If truncated, spill full content to a tmp
 *  file and return a summary with the file path and full size so the agent
 *  can decide how to proceed (e.g. use Read with offset/limit). */
function capText(text: string, maxBytes = MAX_MSG_BYTES): string {
  const fullBytes = Buffer.byteLength(text, "utf-8");
  if (fullBytes <= maxBytes) return text;

  // Write full content to tmp file
  const spillPath = join("/tmp", `pi-process-spill-${Date.now()}-${_spillCounter++}.txt`);
  try { writeFileSync(spillPath, text); } catch { /* best effort */ }

  const totalLines = text.split("\n").length;

  // Truncate for inline display
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(text.slice(0, mid), "utf-8") <= maxBytes - 200) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + `\n\n⚠️ OUTPUT TRUNCATED — full content: ${spillPath} (${totalLines} lines, ${(fullBytes / 1024).toFixed(1)} KB)\nUse the Read tool with offset/limit to inspect the full output.`;
}

function capLine(line: string): string {
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "…" : line;
}

// ── Alert deduplication ─────────────────────────────────────────────────────
const ALERT_COOLDOWN_MS = 30_000; // suppress duplicate alerts for 30s
const _lastAlertTime = new Map<string, number>(); // key: "procId:pattern"

function shouldAlert(procId: string, pattern: string): boolean {
  const key = `${procId}:${pattern}`;
  const now = Date.now();
  const last = _lastAlertTime.get(key) ?? 0;
  if (now - last < ALERT_COOLDOWN_MS) return false;
  _lastAlertTime.set(key, now);
  return true;
}

// ── Types ───────────────────────────────────────────────────────────────────

interface AlertRule {
  pattern: string; // regex source
  label?: string;
}

interface HealthProbe {
  type: "http" | "command";
  label: string;
  url?: string;           // for http type
  pattern?: string;        // regex to match in response body (http) or stdout (command)
  command?: string;        // for command type
  interval?: number;       // seconds between checks (default: 15)
  timeout?: number;        // seconds (default: 5)
  retries?: number;        // consecutive failures before alerting (default: 3)
}

interface HealthProbeState {
  label: string;
  status: "unknown" | "healthy" | "unhealthy";
  failures: number;        // consecutive failure count
  lastCheck?: string;       // ISO timestamp
  lastError?: string;       // last error message
  alerted?: boolean;        // whether we've already sent an alert for current unhealthy state
}

interface ProcMeta {
  id: string;
  name: string;
  command: string;
  pid: number;
  startTime: string;
  exitCode?: number | null;
  signal?: string | null;
  ports?: string[];
  rules?: AlertRule[];
  stopped?: boolean;
  health?: HealthProbe[];
  healthState?: HealthProbeState[];
}

interface TrackedProc {
  meta: ProcMeta;
  child: ChildProcess | null;
  outputFile: string;
  metaFile: string;
  lastReadOffset: number;
  pollTimer?: ReturnType<typeof setInterval>;
  healthTimers?: ReturnType<typeof setInterval>[];
}

// ── State ───────────────────────────────────────────────────────────────────

let procs: Map<string, TrackedProc> = new Map();
let sessionDir = "";
let nextId = 1;

let uiCtx: any = null; // stored for status bar updates

export default function (pi: ExtensionAPI) {
  // ── Helpers ─────────────────────────────────────────────────────────────

  function updateStatusBar() {
    if (!uiCtx) return;
    const theme = uiCtx.ui.theme;

    for (const [, proc] of procs) {
      if (proc.meta.stopped) continue;
      if (!isAlive(proc.meta.pid)) continue;

      // Use cached ports from meta (refreshed by port polling timer)
      const ports = proc.meta.ports || [];
      const portStr = ports.length
        ? `(${ports.map(p => p.replace(/.*:/, "")).join(",")})`
        : "";

      // Health indicators
      let healthStr = "";
      let anyUnhealthy = false;
      if (proc.meta.healthState?.length) {
        const indicators = proc.meta.healthState.map(h => {
          if (h.status === "unhealthy") { anyUnhealthy = true; return `⚠${h.label}`; }
          if (h.status === "healthy") return `✓${h.label}`;
          return `?${h.label}`;
        });
        healthStr = ` ${indicators.join(" ")}`;
      }

      const label = ` ${proc.meta.name} ${portStr}${healthStr} `;
      const bg = anyUnhealthy ? "toolErrorBg" : "toolSuccessBg";
      uiCtx.ui.setStatus(`bg-${proc.meta.id}`, theme.bg(bg, theme.bold(label)));
    }
  }

  function showExitStatus(proc: TrackedProc) {
    if (!uiCtx) return;
    const theme = uiCtx.ui.theme;
    const code = proc.meta.exitCode ?? "?";
    const label = ` ${proc.meta.name} ✖ exit:${code} `;
    uiCtx.ui.setStatus(`bg-${proc.meta.id}`, theme.bg("toolErrorBg", theme.bold(label)));
    setTimeout(() => {
      uiCtx?.ui.setStatus(`bg-${proc.meta.id}`, undefined);
    }, 10000);
  }

  function ensureSessionDir(sessionId: string) {
    sessionDir = join("/tmp", "pi-processes", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    return sessionDir;
  }

  function metaPath(id: string) {
    return join(sessionDir, `${id}-meta.json`);
  }

  function outputPath(id: string) {
    return join(sessionDir, `${id}-output.txt`);
  }

  function writeMeta(proc: TrackedProc) {
    writeFileSync(proc.metaFile, JSON.stringify(proc.meta, null, 2));
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function getAllDescendants(pid: number): Set<number> {
    // Single call: get all PIDs and their parents, then walk the tree in JS
    const pids = new Set<number>([pid]);
    try {
      const out = execSync(`ps -eo pid,ppid --no-headers 2>/dev/null`, { encoding: "utf-8" });
      const childMap = new Map<number, number[]>();
      for (const line of out.trim().split("\n")) {
        const parts = line.trim().split(/\s+/);
        const p = parseInt(parts[0], 10);
        const pp = parseInt(parts[1], 10);
        if (!isNaN(p) && !isNaN(pp)) {
          if (!childMap.has(pp)) childMap.set(pp, []);
          childMap.get(pp)!.push(p);
        }
      }
      const queue = [pid];
      while (queue.length > 0) {
        const p = queue.shift()!;
        for (const child of childMap.get(p) || []) {
          if (!pids.has(child)) {
            pids.add(child);
            queue.push(child);
          }
        }
      }
    } catch { /* fallback: just the root pid */ }
    return pids;
  }

  // Cached ss output — refreshed by port polling timer
  let _ssCache: { lines: string[]; ts: number } = { lines: [], ts: 0 };

  function refreshSsCache() {
    try {
      const out = execSync(`ss -tlnp 2>/dev/null`, { encoding: "utf-8" });
      _ssCache = { lines: out.trim().split("\n"), ts: Date.now() };
    } catch {
      _ssCache = { lines: [], ts: Date.now() };
    }
  }

  function getPorts(pid: number): string[] {
    try {
      const pids = getAllDescendants(pid);

      // Use cached ss output (refreshed every 10s by port timer)
      if (Date.now() - _ssCache.ts > 15000) refreshSsCache();

      const ports: string[] = [];
      for (const line of _ssCache.lines) {
        for (const p of pids) {
          if (line.includes(`pid=${p},`)) {
            const match = line.match(/\s+([\d.*:[\]]+:\d+)\s+/);
            if (match) ports.push(match[1]);
            break;
          }
        }
      }
      return [...new Set(ports)];
    } catch {
      return [];
    }
  }

  function readOutput(proc: TrackedProc): string {
    try {
      return readFileSync(proc.outputFile, "utf-8");
    } catch {
      return "";
    }
  }

  function getNewOutput(proc: TrackedProc): string {
    try {
      const stat = statSync(proc.outputFile);
      if (stat.size <= proc.lastReadOffset) return "";
      const fd = require("fs").openSync(proc.outputFile, "r");
      const buf = Buffer.alloc(stat.size - proc.lastReadOffset);
      require("fs").readSync(fd, buf, 0, buf.length, proc.lastReadOffset);
      require("fs").closeSync(fd);
      proc.lastReadOffset = stat.size;
      return buf.toString("utf-8");
    } catch {
      return "";
    }
  }

  // ── Health monitoring ───────────────────────────────────────────────────

  async function runHealthProbe(probe: HealthProbe): Promise<{ ok: boolean; error?: string }> {
    const timeout = (probe.timeout ?? 5) * 1000;

    if (probe.type === "http" && probe.url) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        const res = await fetch(probe.url, { signal: controller.signal });
        clearTimeout(timer);
        const body = await res.text();

        if (!res.ok) {
          return { ok: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
        }
        if (probe.pattern) {
          const re = new RegExp(probe.pattern, "i");
          if (!re.test(body)) {
            return { ok: false, error: `Pattern /${probe.pattern}/ not found in response (${body.length} bytes)` };
          }
        }
        return { ok: true };
      } catch (e: any) {
        return { ok: false, error: e.message?.slice(0, 200) || "Unknown error" };
      }
    }

    if (probe.type === "command" && probe.command) {
      try {
        execSync(probe.command, { encoding: "utf-8", timeout, stdio: "pipe" });
        return { ok: true };
      } catch (e: any) {
        const stderr = e.stderr?.slice(0, 200) || e.message?.slice(0, 200) || "Non-zero exit";
        return { ok: false, error: stderr };
      }
    }

    return { ok: false, error: "Invalid probe configuration" };
  }

  function startHealthMonitoring(proc: TrackedProc) {
    if (!proc.meta.health?.length) return;

    // Initialize health state if needed
    if (!proc.meta.healthState || proc.meta.healthState.length !== proc.meta.health.length) {
      proc.meta.healthState = proc.meta.health.map(h => ({
        label: h.label,
        status: "unknown" as const,
        failures: 0,
      }));
    }

    proc.healthTimers = [];

    for (let i = 0; i < proc.meta.health.length; i++) {
      const probe = proc.meta.health[i];
      const interval = (probe.interval ?? 15) * 1000;
      const maxRetries = probe.retries ?? 3;

      const timer = setInterval(async () => {
        if (proc.meta.stopped) {
          clearInterval(timer);
          return;
        }

        const state = proc.meta.healthState![i];
        const result = await runHealthProbe(probe);
        state.lastCheck = new Date().toISOString();

        if (result.ok) {
          const wasUnhealthy = state.status === "unhealthy";
          state.status = "healthy";
          state.failures = 0;
          state.lastError = undefined;
          state.alerted = false;
          writeMeta(proc);
          updateStatusBar();

          if (wasUnhealthy) {
            pi.sendMessage(
              {
                customType: "process-alert",
                content: capText(`✅ Health recovered: **${probe.label}** on **${proc.meta.name}** (${proc.meta.id}) is healthy again.`),
                display: true,
              },
              { triggerTurn: false, deliverAs: "followUp" }
            );
          }
        } else {
          state.failures++;
          state.lastError = result.error;

          if (state.failures >= maxRetries) {
            state.status = "unhealthy";
            writeMeta(proc);
            updateStatusBar();

            if (!state.alerted) {
              state.alerted = true;
              const healthMsg = capText(`🚨 Health check failed: **${probe.label}** on **${proc.meta.name}** (${proc.meta.id})\nType: ${probe.type}\n${probe.url ? `URL: ${probe.url}` : `Command: ${probe.command}`}\nConsecutive failures: ${state.failures}\nError: ${capLine(result.error || "unknown")}`);
              pi.sendMessage(
                {
                  customType: "process-alert",
                  content: healthMsg,
                  display: true,
                },
                { triggerTurn: true, deliverAs: "followUp" }
              );
            }
          } else {
            writeMeta(proc);
          }
        }
      }, interval);

      proc.healthTimers.push(timer);
    }
  }

  function stopHealthMonitoring(proc: TrackedProc) {
    if (proc.healthTimers) {
      for (const timer of proc.healthTimers) {
        clearInterval(timer);
      }
      proc.healthTimers = undefined;
    }
  }

  // Port refresh + status bar timer (10s interval, single timer for all procs)
  let portRefreshTimer: ReturnType<typeof setInterval> | null = null;

  function ensurePortRefreshTimer() {
    if (portRefreshTimer) return;
    portRefreshTimer = setInterval(() => {
      let anyRunning = false;
      for (const [, proc] of procs) {
        if (proc.meta.stopped || !isAlive(proc.meta.pid)) continue;
        anyRunning = true;
        proc.meta.ports = getPorts(proc.meta.pid);
        writeMeta(proc);
      }
      updateStatusBar();
      if (!anyRunning) {
        clearInterval(portRefreshTimer!);
        portRefreshTimer = null;
      }
    }, 10000);
  }

  function startPolling(proc: TrackedProc) {
    if (proc.pollTimer) return;
    ensurePortRefreshTimer();

    proc.pollTimer = setInterval(() => {
      // Check if process exited (lightweight — just kill(pid,0))
      if (!proc.meta.stopped && !isAlive(proc.meta.pid)) {
        let exitCode: number | null = (proc as any)._exitCode ?? null;
        proc.meta.exitCode = exitCode;
        proc.meta.stopped = true;
        writeMeta(proc);
        stopPolling(proc);
        showExitStatus(proc);

        const { text: rawTail, totalLines, shown } = tailOutput(proc, 10);
        const cappedTail = rawTail.split("\n").map(capLine).join("\n");
        const { content: tailText } = truncateTail(cappedTail, { maxLines: 10 });
        const truncNote = totalLines > shown ? `\n(showing last ${shown} of ${totalLines} total lines — use process_tail/process_grep for more)` : "";
        const exitMsg = capText(`⚠️ Background process **${proc.meta.name}** (${proc.meta.id}) exited.\nCommand: \`${proc.meta.command}\`\nExit code: ${proc.meta.exitCode ?? "unknown"}\n${truncNote}\nLast ${shown} lines:\n\`\`\`\n${tailText}\n\`\`\``);
        pi.sendMessage(
          {
            customType: "bg-alert",
            content: exitMsg,
            display: true,
          },
          { triggerTurn: true, deliverAs: "followUp" }
        );
        return;
      }

      // Check alert rules
      if (!proc.meta.rules?.length) return;
      const newOutput = getNewOutput(proc);
      if (!newOutput) return;

      for (const rule of proc.meta.rules!) {
        try {
          const re = new RegExp(rule.pattern, "gim");
          const matches: string[] = [];
          for (const line of newOutput.split("\n")) {
            if (re.test(line)) matches.push(line);
            re.lastIndex = 0;
          }
          if (matches.length > 0 && shouldAlert(proc.meta.id, rule.pattern)) {
            const label = rule.label || rule.pattern;
            const cappedMatches = matches.slice(0, 20).map(capLine).join("\n");
            const alertMsg = capText(`🚨 Alert [${label}] on **${proc.meta.id}** (\`${proc.meta.command}\`):\n\`\`\`\n${cappedMatches}\n\`\`\``);
            pi.sendMessage(
              {
                customType: "bg-alert",
                content: alertMsg,
                display: true,
              },
              { triggerTurn: true, deliverAs: "followUp" }
            );
          }
        } catch { /* bad regex, skip */ }
      }
    }, 2000);
  }

  function stopPolling(proc: TrackedProc) {
    if (proc.pollTimer) {
      clearInterval(proc.pollTimer);
      proc.pollTimer = undefined;
    }
    stopHealthMonitoring(proc);
  }

  function tailOutput(proc: TrackedProc, lines: number): { text: string; totalLines: number; shown: number } {
    const content = readOutput(proc);
    const allLines = content.split("\n");
    const totalLines = allLines.length;
    const sliced = allLines.slice(-lines);
    return { text: sliced.join("\n"), totalLines, shown: sliced.length };
  }

  function getProc(id: string): TrackedProc | undefined {
    return procs.get(id);
  }

  function formatUptime(startTime: string): string {
    const ms = Date.now() - new Date(startTime).getTime();
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    uiCtx = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    ensureSessionDir(sessionId);

    // Restore state from session entries (survives /reload)
    const stateEntry = ctx.sessionManager
      .getEntries()
      .reverse()
      .find((e: any) => e.type === "custom" && e.customType === "bg-proc-state");

    if (stateEntry) {
      const data = (stateEntry as any).data as {
        procIds: string[];
        nextId: number;
      };
      nextId = data.nextId || 1;

      for (const id of data.procIds) {
        const mf = metaPath(id);
        const of = outputPath(id);
        if (!existsSync(mf)) continue;

        const meta: ProcMeta = JSON.parse(readFileSync(mf, "utf-8"));
        const tracked: TrackedProc = {
          meta,
          child: null,
          outputFile: of,
          metaFile: mf,
          lastReadOffset: 0,
        };

        // Fast-forward offset to current file size so we only alert on NEW output
        try {
          tracked.lastReadOffset = statSync(of).size;
        } catch { /* file might not exist yet */ }

        if (!meta.stopped && isAlive(meta.pid)) {
          procs.set(id, tracked);
          startPolling(tracked);
          if (meta.health?.length) startHealthMonitoring(tracked);
          ctx.ui.notify(`Reconnected to bg process ${id} "${meta.name}" (PID ${meta.pid})`, "info");
        } else if (meta.exitCode === undefined) {
          // Died while we were reloading
          meta.exitCode = null;
          meta.stopped = true;
          writeMeta(tracked);
          procs.set(id, tracked);
        }
      }
    }

    updateStatusBar();
  });

  pi.on("session_shutdown", async () => {
    // Clear status bar
    for (const [id] of procs) {
      uiCtx?.ui.setStatus(`bg-${id}`, undefined);
    }

    // Save state for reload recovery
    const procIds = [...procs.keys()];
    pi.appendEntry("bg-proc-state", { procIds, nextId });

    // Stop polling but DON'T kill processes — they're detached and survive reload.
    // Use process_stop to explicitly kill processes. On pi exit, detached processes
    // continue running (harmless, they write to /tmp and eventually finish).
    for (const [, proc] of procs) {
      stopPolling(proc);
    }
    if (portRefreshTimer) {
      clearInterval(portRefreshTimer);
      portRefreshTimer = null;
    }

    procs.clear();
  });

  // ── Tools ───────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "process_start",
    label: "Start Background Process",
    description:
      "Start a shell command in the background. Output is captured to disk. Optionally set alert rules (regex patterns) that notify you when matched in output. If there are already running processes, you MUST first call this with confirm=false to see them, then call again with confirm=true to proceed.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run" }),
      name: Type.String({ description: "Friendly name for this process (shown in status bar)" }),
      confirm: Type.Optional(Type.Boolean({ description: "Set to true to confirm starting despite other running processes. Omit or false for initial call.", default: false })),
      rules: Type.Optional(
        Type.Array(
          Type.Object({
            pattern: Type.String({ description: "Regex pattern to watch for in output" }),
            label: Type.Optional(Type.String({ description: "Human-readable label for this alert" })),
          }),
          { description: "Alert rules — trigger a notification when pattern matches in output" }
        )
      ),
      health: Type.Optional(
        Type.Array(
          Type.Object({
            type: Type.Union([Type.Literal("http"), Type.Literal("command")], { description: "Probe type" }),
            label: Type.String({ description: "Short label for this probe (e.g. 'fe', 'api', 'db')" }),
            url: Type.Optional(Type.String({ description: "URL to probe (for http type)" })),
            pattern: Type.Optional(Type.String({ description: "Regex pattern to match in response body (http) or stdout (command)" })),
            command: Type.Optional(Type.String({ description: "Command to run (for command type, must exit 0)" })),
            interval: Type.Optional(Type.Number({ description: "Seconds between checks (default: 15)" })),
            timeout: Type.Optional(Type.Number({ description: "Probe timeout in seconds (default: 5)" })),
            retries: Type.Optional(Type.Number({ description: "Consecutive failures before alerting (default: 3)" })),
          }),
          { description: "Health probes — monitor endpoints or commands, alert on failure" }
        )
      ),
    }),
    async execute(_id, params) {
      // Check for already running processes
      const running: TrackedProc[] = [];
      for (const [, proc] of procs) {
        if (!proc.meta.stopped && isAlive(proc.meta.pid)) {
          running.push(proc);
        }
      }

      if (running.length > 0 && !params.confirm) {
        const list = running.map(p => {
          const ports = (p.meta.ports || []).map(pt => pt.replace(/.*:/, "")).join(",");
          const portStr = ports ? ` (ports: ${ports})` : "";
          return `  • ${p.meta.id} "${p.meta.name}" — \`${p.meta.command}\`${portStr}`;
        }).join("\n");
        return {
          content: [{
            type: "text",
            text: `⚠️ There are ${running.length} running process(es):\n${list}\n\nAre you sure you want to start another process? Call process_start again with confirm=true to proceed, or use process_stop to stop an existing one first.`,
          }],
        };
      }

      const id = `proc-${nextId++}`;
      const of = outputPath(id);
      const mf = metaPath(id);

      // Create output file
      writeFileSync(of, "");

      // Spawn detached with output redirect via exec, avoiding escaping issues
      // by writing command to a script file
      const scriptFile = join(sessionDir, `${id}-run.sh`);
      writeFileSync(scriptFile, `#!/bin/bash\nexec > "${of}" 2>&1\n${params.command}\n`, { mode: 0o755 });

      const child = spawn(scriptFile, [], {
        detached: true,
        stdio: "ignore",
        shell: false,
      });
      child.unref();

      const meta: ProcMeta = {
        id,
        name: params.name,
        command: params.command,
        pid: child.pid!,
        startTime: new Date().toISOString(),
        rules: params.rules,
        health: params.health,
      };

      const tracked: TrackedProc = {
        meta,
        child,
        outputFile: of,
        metaFile: mf,
        lastReadOffset: 0,
      };

      writeMeta(tracked);
      procs.set(id, tracked);
      startPolling(tracked);

      // Start health monitoring after a delay (give the process time to start)
      if (params.health?.length) {
        setTimeout(() => {
          if (!tracked.meta.stopped) {
            startHealthMonitoring(tracked);
          }
        }, 5000);
      }

      // Exit code is captured by the poller which also sends the alert message.
      // We only use child.on("exit") to store the actual exit code/signal for accuracy.
      child.on("exit", (code, signal) => {
        tracked.meta.signal = signal;
        // Store exit code in a separate field so poller can use it
        (tracked as any)._exitCode = code;
      });

      updateStatusBar();

      // Refresh ports after a short delay (server needs time to bind)
      setTimeout(() => {
        if (!tracked.meta.stopped) {
          refreshSsCache();
          tracked.meta.ports = getPorts(tracked.meta.pid);
          writeMeta(tracked);
          updateStatusBar();
        }
      }, 3000);

      return {
        content: [
          {
            type: "text",
            text: `Started background process **${id}** (${params.name})\nCommand: \`${params.command}\`\nPID: ${child.pid}\nOutput: ${of}\nRules: ${params.rules?.length || 0} alert rule(s)\nHealth probes: ${params.health?.length || 0} (${params.health?.map(h => h.label).join(", ") || "none"})`,
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "process_stop",
    label: "Stop Background Process",
    description: "Stop a background process by ID. Sends SIGTERM, then SIGKILL after 3 seconds if still alive.",
    parameters: Type.Object({
      id: Type.String({ description: "Process ID (e.g. proc-1)" }),
    }),
    async execute(_id, params) {
      const proc = getProc(params.id);
      if (!proc) return { content: [{ type: "text", text: `Process ${params.id} not found.` }] };

      if (proc.meta.stopped || !isAlive(proc.meta.pid)) {
        return { content: [{ type: "text", text: `Process ${params.id} is already stopped.` }] };
      }

      // Mark stopped and stop polling BEFORE killing, so the poller
      // doesn't fire an exit alert for an intentional stop
      proc.meta.stopped = true;
      stopPolling(proc);

      try {
        // Kill process group
        process.kill(-proc.meta.pid, "SIGTERM");
      } catch {
        try {
          process.kill(proc.meta.pid, "SIGTERM");
        } catch { /* already dead */ }
      }

      // Wait and force kill if needed
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (isAlive(proc.meta.pid)) {
        try {
          process.kill(-proc.meta.pid, "SIGKILL");
        } catch {
          try {
            process.kill(proc.meta.pid, "SIGKILL");
          } catch { /* already dead */ }
        }
      }

      // SIGTERM = signal 15, conventional exit code is 128+15=143
      // SIGKILL = signal 9, conventional exit code is 128+9=137
      proc.meta.exitCode = proc.meta.exitCode ?? (isAlive(proc.meta.pid) ? 137 : 143);
      proc.meta.signal = proc.meta.signal ?? "SIGTERM";
      writeMeta(proc);
      showExitStatus(proc);

      return { content: [{ type: "text", text: `Stopped process ${params.id} "${proc.meta.name}" (PID ${proc.meta.pid}, exit: ${proc.meta.exitCode}).` }] };
    },
  });

  pi.registerTool({
    name: "process_status",
    label: "Background Process Status",
    description:
      "Show status of all tracked background processes (running and exited). Shows ID, command, PID, uptime/exit code, and listening ports.",
    parameters: Type.Object({}),
    async execute() {
      if (procs.size === 0) {
        return { content: [{ type: "text", text: "No tracked background processes." }] };
      }

      const lines: string[] = [];
      for (const [, proc] of procs) {
        const alive = isAlive(proc.meta.pid);
        const ports = alive ? getPorts(proc.meta.pid) : [];
        if (alive && ports.length) {
          proc.meta.ports = ports;
          writeMeta(proc);
        }

        const status = alive
          ? `🟢 running (${formatUptime(proc.meta.startTime)})`
          : `🔴 stopped (exit: ${proc.meta.exitCode ?? "unknown"})`;
        const portStr = ports.length ? `\n  Ports: ${ports.join(", ")}` : "";
        const ruleStr = proc.meta.rules?.length ? `\n  Rules: ${proc.meta.rules.map((r) => r.label || r.pattern).join(", ")}` : "";
        let healthStr = "";
        if (proc.meta.healthState?.length) {
          const indicators = proc.meta.healthState.map(h => {
            const icon = h.status === "healthy" ? "✅" : h.status === "unhealthy" ? "❌" : "❓";
            return `${icon}${h.label}`;
          });
          healthStr = `\n  Health: ${indicators.join(" ")}`;
        }

        lines.push(`**${proc.meta.id}** "${proc.meta.name}" — \`${proc.meta.command}\`\n  PID: ${proc.meta.pid} | ${status}${portStr}${ruleStr}${healthStr}`);
      }

      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    },
  });

  pi.registerTool({
    name: "process_ports",
    label: "Background Process Ports",
    description: "Show all listening ports for a background process (checks the process and its children).",
    parameters: Type.Object({
      id: Type.String({ description: "Process ID (e.g. proc-1)" }),
    }),
    async execute(_id, params) {
      const proc = getProc(params.id);
      if (!proc) return { content: [{ type: "text", text: `Process ${params.id} not found.` }] };

      if (!isAlive(proc.meta.pid)) {
        return { content: [{ type: "text", text: `Process ${params.id} is not running.` }] };
      }

      const ports = getPorts(proc.meta.pid);
      proc.meta.ports = ports;
      writeMeta(proc);

      if (ports.length === 0) {
        return { content: [{ type: "text", text: `Process ${params.id} (PID ${proc.meta.pid}) is not listening on any ports.` }] };
      }

      return { content: [{ type: "text", text: `Process ${params.id} (PID ${proc.meta.pid}) listening on:\n${ports.map((p) => `  • ${p}`).join("\n")}` }] };
    },
  });

  pi.registerTool({
    name: "process_tail",
    label: "Tail Background Process Output",
    description: "Show the last N lines of a background process's output.",
    parameters: Type.Object({
      id: Type.String({ description: "Process ID (e.g. proc-1)" }),
      lines: Type.Optional(Type.Number({ description: "Number of lines to show (default: 100)", default: 100 })),
    }),
    async execute(_id, params) {
      const proc = getProc(params.id);
      if (!proc) return { content: [{ type: "text", text: `Process ${params.id} not found.` }] };

      const n = params.lines ?? 100;
      const { text, totalLines, shown } = tailOutput(proc, n);

      if (!text.trim()) {
        return { content: [{ type: "text", text: `Process ${params.id} has no output yet.` }] };
      }

      const result = truncateTail(text, { maxLines: n });
      const truncNote = totalLines > shown ? `(showing last ${shown} of ${totalLines} total lines)` : `(${totalLines} total lines)`;
      return { content: [{ type: "text", text: `${params.id} output ${truncNote}:\n\`\`\`\n${result.content}\n\`\`\`` }] };
    },
  });

  pi.registerTool({
    name: "process_grep",
    label: "Grep Background Process Output",
    description: "Search a background process's output with a regex pattern. Returns matching lines with line numbers.",
    parameters: Type.Object({
      id: Type.String({ description: "Process ID (e.g. proc-1)" }),
      pattern: Type.String({ description: "Regex pattern to search for" }),
      max: Type.Optional(Type.Number({ description: "Max matches to return (default: 50)", default: 50 })),
    }),
    async execute(_id, params) {
      const proc = getProc(params.id);
      if (!proc) return { content: [{ type: "text", text: `Process ${params.id} not found.` }] };

      const content = readOutput(proc);
      if (!content.trim()) {
        return { content: [{ type: "text", text: `Process ${params.id} has no output yet.` }] };
      }

      let re: RegExp;
      try {
        re = new RegExp(params.pattern, "i");
      } catch (e: any) {
        return { content: [{ type: "text", text: `Invalid regex: ${e.message}` }] };
      }

      const lines = content.split("\n");
      const matches: string[] = [];
      const maxMatches = params.max ?? 50;
      let totalMatches = 0;

      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          totalMatches++;
          if (matches.length < maxMatches) {
            matches.push(`${i + 1}: ${lines[i]}`);
          }
        }
      }

      if (totalMatches === 0) {
        return { content: [{ type: "text", text: `No matches for /${params.pattern}/i in ${params.id} output (searched ${lines.length} lines).` }] };
      }

      const result = truncateTail(matches.join("\n"), { maxLines: maxMatches });
      const truncNote = totalMatches > matches.length ? ` (showing ${matches.length} of ${totalMatches} total matches)` : "";
      return {
        content: [
          {
            type: "text",
            text: `${matches.length} match(es) for /${params.pattern}/i in ${params.id}${truncNote} (${lines.length} lines searched):\n\`\`\`\n${result.content}\n\`\`\``,
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "process_list_old",
    label: "List Historical Background Processes",
    description: "List all background processes from this session (including exited ones), reading from the /tmp persistence directory.",
    parameters: Type.Object({}),
    async execute() {
      if (!sessionDir || !existsSync(sessionDir)) {
        return { content: [{ type: "text", text: "No session directory found." }] };
      }

      const files = readdirSync(sessionDir).filter((f) => f.endsWith("-meta.json"));
      if (files.length === 0) {
        return { content: [{ type: "text", text: "No historical processes found." }] };
      }

      const lines: string[] = [];
      for (const file of files.sort()) {
        try {
          const meta: ProcMeta = JSON.parse(readFileSync(join(sessionDir, file), "utf-8"));
          const alive = isAlive(meta.pid);
          const status = alive
            ? `🟢 running (${formatUptime(meta.startTime)})`
            : `🔴 stopped (exit: ${meta.exitCode ?? "unknown"})`;
          const tracked = procs.has(meta.id) ? " [tracked]" : "";
          lines.push(`**${meta.id}** "${meta.name}" — \`${meta.command}\` | PID ${meta.pid} | ${status}${tracked}`);
        } catch { /* corrupt meta, skip */ }
      }

      return { content: [{ type: "text", text: lines.join("\n") || "No processes found." }] };
    },
  });

  pi.registerTool({
    name: "process_health",
    label: "Background Process Health",
    description: "Show health probe status for all monitored background processes.",
    parameters: Type.Object({}),
    async execute() {
      const lines: string[] = [];

      for (const [, proc] of procs) {
        if (!proc.meta.health?.length) continue;

        const probeLines = (proc.meta.healthState || []).map(h => {
          const icon = h.status === "healthy" ? "✅" : h.status === "unhealthy" ? "❌" : "❓";
          const lastCheck = h.lastCheck ? ` (checked ${new Date(h.lastCheck).toLocaleTimeString()})` : "";
          const error = h.lastError ? `\n      Last error: ${h.lastError}` : "";
          const failures = h.failures > 0 ? ` | failures: ${h.failures}` : "";
          return `    ${icon} **${h.label}**: ${h.status}${failures}${lastCheck}${error}`;
        });

        const alive = isAlive(proc.meta.pid);
        const status = alive ? "🟢 running" : "🔴 stopped";
        lines.push(`**${proc.meta.id}** "${proc.meta.name}" — ${status}\n${probeLines.join("\n")}`);
      }

      if (lines.length === 0) {
        return { content: [{ type: "text", text: "No processes with health probes configured." }] };
      }

      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    },
  });

  // ── Custom message renderer for alerts ──────────────────────────────────

  pi.registerMessageRenderer("bg-alert", (message, _options, theme) => {
    const { Text } = require("@mariozechner/pi-tui");
    const content = String(message.content || "");
    const isError = content.includes("🚨");
    const color = isError ? "error" : "warning";
    return new Text(theme.fg(color, content), 0, 0);
  });
}
