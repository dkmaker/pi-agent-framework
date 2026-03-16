/**
 * SettingsLoader — reads, watches, and manages settings.json and per-agent agent.json.
 *
 * Features:
 * - Async factory: SettingsLoader.create(projectRoot, settingsPath?)
 * - Deep merges missing fields into existing files on every load
 * - fs.watch() on settings.json for live config/ACL updates
 * - EventEmitter for change notifications
 * - Per-agent config resolution with defaults merging
 *
 * Reference: asset [n2j36dl7]
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AclRule, AgentConfig, Settings } from "./types.js";
import { DEFAULT_AGENT_CONFIG, DEFAULT_SETTINGS } from "./types.js";

export interface SettingsEvents {
  changed: [settings: Settings];
  acl_changed: [acl: AclRule[]];
  agent_changed: [name: string, config: AgentConfig];
}

export class SettingsLoader extends EventEmitter<SettingsEvents> {
  private settings: Settings;
  private agentConfigs: Map<string, AgentConfig> = new Map();
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private projectRoot: string,
    private settingsPath: string,
  ) {
    super();
    this.settings = structuredClone(DEFAULT_SETTINGS);
  }

  /**
   * Create and initialize a SettingsLoader.
   * Reads settings.json (creating with defaults if missing),
   * merges missing fields, loads all agent configs.
   */
  static async create(projectRoot: string, settingsPath?: string): Promise<SettingsLoader> {
    const resolved = settingsPath ?? path.join(projectRoot, ".pi", "agents", "settings.json");
    const loader = new SettingsLoader(projectRoot, resolved);
    await loader.loadSettings();
    loader.startWatching();
    return loader;
  }

  // ─── Public API ─────────────────────────────────────────────────

  getSettings(): Settings {
    return structuredClone(this.settings);
  }

  getAgentConfig(name: string): AgentConfig | undefined {
    const config = this.agentConfigs.get(name);
    return config ? structuredClone(config) : undefined;
  }

  getAllAgentConfigs(): AgentConfig[] {
    return Array.from(this.agentConfigs.values()).map((c) => structuredClone(c));
  }

  getAcl(): AclRule[] {
    return structuredClone(this.settings.acl);
  }

  /**
   * Reload settings from disk. Called on fs.watch or manually.
   */
  async reloadSettings(): Promise<void> {
    const oldAcl = JSON.stringify(this.settings.acl);
    await this.loadSettings();
    const newAcl = JSON.stringify(this.settings.acl);

    this.emit("changed", this.settings);
    if (oldAcl !== newAcl) {
      this.emit("acl_changed", this.settings.acl);
    }
  }

  /**
   * Update ACL rules and write back to settings.json.
   */
  async updateAcl(acl: AclRule[]): Promise<void> {
    this.settings.acl = acl;
    await this.writeSettings();
    this.emit("acl_changed", acl);
  }

  /**
   * Update the full settings object and write to disk.
   */
  async updateSettings(updates: Partial<Settings>): Promise<void> {
    Object.assign(this.settings, updates);
    await this.writeSettings();
    this.emit("changed", this.settings);
  }

  /**
   * Resolve the absolute path for an agent folder.
   */
  resolveAgentPath(agentPath: string): string {
    if (path.isAbsolute(agentPath)) return agentPath;
    return path.join(this.projectRoot, agentPath);
  }

  /**
   * Stop watching and clean up.
   */
  dispose(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.removeAllListeners();
  }

  // ─── Internal ───────────────────────────────────────────────────

  private async loadSettings(): Promise<void> {
    // Ensure directory exists
    const dir = path.dirname(this.settingsPath);
    await fs.promises.mkdir(dir, { recursive: true });

    // Read or create settings.json
    let raw: Partial<Settings>;
    try {
      const content = await fs.promises.readFile(this.settingsPath, "utf-8");
      raw = JSON.parse(content);
    } catch {
      // File doesn't exist or is invalid — create with defaults
      raw = {};
    }

    // Deep merge missing fields from defaults
    this.settings = deepMerge(structuredClone(DEFAULT_SETTINGS), raw);

    // Rewrite file so it always shows every field
    await this.writeSettings();

    // Load all agent configs
    this.agentConfigs.clear();
    for (const agentPath of this.settings.agents) {
      try {
        const config = await this.loadAgentConfig(agentPath);
        this.agentConfigs.set(config.name, config);
      } catch (err) {
        console.error(`Failed to load agent config at ${agentPath}: ${err}`);
      }
    }
  }

  private async loadAgentConfig(agentPath: string): Promise<AgentConfig> {
    const absPath = this.resolveAgentPath(agentPath);
    const configPath = path.join(absPath, "agent.json");

    let raw: Partial<AgentConfig>;
    try {
      const content = await fs.promises.readFile(configPath, "utf-8");
      raw = JSON.parse(content);
    } catch {
      raw = {};
    }

    // Agent name defaults to folder name
    const name = raw.name ?? path.basename(absPath);

    // Merge: agent values win over settings.defaults
    const defaults = this.settings.defaults;
    const config: AgentConfig = {
      ...DEFAULT_AGENT_CONFIG,
      provider: defaults.provider,
      model: defaults.model,
      thinking: defaults.thinking,
      cutoff_polite_pct: defaults.cutoff_polite_pct,
      cutoff_hard_pct: defaults.cutoff_hard_pct,
      ...raw,
      name,
    };

    // Rewrite agent.json so all fields are present
    await fs.promises.mkdir(absPath, { recursive: true });
    await fs.promises.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    return config;
  }

  private async writeSettings(): Promise<void> {
    const dir = path.dirname(this.settingsPath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(this.settingsPath, `${JSON.stringify(this.settings, null, 2)}\n`);
  }

  private startWatching(): void {
    try {
      this.watcher = fs.watch(this.settingsPath, () => {
        // Debounce — multiple change events fire in quick succession
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.reloadSettings().catch((err) => console.error(`Settings reload failed: ${err}`));
        }, 200);
      });
    } catch {
      // Watch may fail on some platforms — non-fatal
      console.warn(`Could not watch ${this.settingsPath}`);
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────────

/**
 * Deep merge source into target. Source values win.
 * Only merges plain objects — arrays and primitives from source replace target.
 */
function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key of Object.keys(source) as Array<keyof T>) {
    const sourceVal = source[key];
    const targetVal = result[key];

    if (
      sourceVal !== undefined &&
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      typeof targetVal === "object" &&
      targetVal !== null &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(targetVal as Record<string, unknown>, sourceVal as Record<string, unknown>) as T[keyof T];
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal as T[keyof T];
    }
  }
  return result;
}
