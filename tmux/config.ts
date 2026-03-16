/**
 * Configuration system for developer-mode.
 * Auto-creates config with smart defaults on first use.
 * Merges new defaults into existing config on load (preserving user values).
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

// ─── Types ───────────────────────────────────────────────────────────

export interface DeveloperModeConfig {
  terminal: "auto" | "kitty" | "gnome-terminal" | "xfce4-terminal" | "konsole" | "xterm";
  tmux: {
    socketPrefix: string;
    embeddedConfig: boolean;
    defaultPiArgs: string;
  };
  spawn: {
    defaultArgs: string;
    timeout: number;
    maxConcurrent: number;
  };
  staleness: {
    checkIntervalHours: number;
  };
}

// ─── Defaults ────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: DeveloperModeConfig = {
  terminal: "auto",
  tmux: {
    socketPrefix: "/tmp/pi-dev",
    embeddedConfig: true,
    defaultPiArgs: "--no-session",
  },
  spawn: {
    defaultArgs: "--mode json --print --no-session --no-extensions --no-skills",
    timeout: 60,
    maxConcurrent: 5,
  },
  staleness: {
    checkIntervalHours: 24,
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────

function getPiHome(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi");
}

function getConfigPath(): string {
  return path.join(getPiHome(), "developer-mode.json");
}

/**
 * Deep merge: defaults are overridden by existing user values.
 * New keys from defaults are added; user keys not in defaults are preserved.
 */
function deepMerge(defaults: Record<string, any>, existing: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = { ...defaults };
  for (const key of Object.keys(existing)) {
    if (
      key in result &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key]) &&
      typeof existing[key] === "object" &&
      existing[key] !== null &&
      !Array.isArray(existing[key])
    ) {
      result[key] = deepMerge(result[key], existing[key]);
    } else {
      result[key] = existing[key];
    }
  }
  return result;
}

// ─── Terminal detection ──────────────────────────────────────────────

function commandExists(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function detectTerminal(): string {
  // 1. Check TERM_PROGRAM env
  const termProgram = process.env.TERM_PROGRAM;
  if (termProgram) {
    const normalized = termProgram.toLowerCase();
    if (normalized.includes("kitty")) return "kitty";
    if (normalized.includes("gnome")) return "gnome-terminal";
    if (normalized.includes("xfce")) return "xfce4-terminal";
    if (normalized.includes("konsole")) return "konsole";
    if (normalized.includes("xterm")) return "xterm";
  }

  // 2. Probe in preference order
  const probeOrder = ["kitty", "gnome-terminal", "xfce4-terminal", "konsole", "xterm"];
  for (const term of probeOrder) {
    if (commandExists(term)) return term;
  }

  return "xterm"; // fallback
}

// ─── Public API ──────────────────────────────────────────────────────

let _cachedConfig: DeveloperModeConfig | null = null;

/**
 * Load config from disk, creating or merging with defaults as needed.
 * Result is cached; call `reloadConfig()` to refresh.
 */
export function loadConfig(): DeveloperModeConfig {
  if (_cachedConfig) return _cachedConfig;

  const configPath = getConfigPath();
  let existing: Record<string, any> = {};

  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch (e) {
      // Silently fall back to defaults
    }
  }

  const merged = deepMerge(DEFAULT_CONFIG as any, existing) as DeveloperModeConfig;

  // Write back so file always has all current keys
  try {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  } catch (e) {
    // Silently ignore config write failures
  }

  _cachedConfig = merged;
  return merged;
}

/**
 * Force re-read from disk on next `loadConfig()` call.
 */
export function reloadConfig(): void {
  _cachedConfig = null;
}

/**
 * Resolve the effective terminal (handles "auto").
 */
export function resolveTerminal(config?: DeveloperModeConfig): string {
  const c = config || loadConfig();
  return c.terminal === "auto" ? detectTerminal() : c.terminal;
}
