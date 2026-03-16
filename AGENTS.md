# Pi Agent Framework — Source Map & Dependency Analysis

A multi-agent orchestration system for pi. This repo contains all the source files
extracted from multiple locations, organized for analysis and refactoring into a
standalone, self-contained package.

---

## Directory Structure

```
pi-agent-framework/
├── AGENTS.md                     ← This file
├── core/                         ← The agents system itself (already self-contained code)
│   ├── shared/                   ← Shared modules used by BOTH manager and child agents
│   │   ├── acl.ts                ← ACL loader — reads acl.json permissions
│   │   ├── messaging.ts          ← Filesystem inbox/outbox messaging system
│   │   ├── threads.ts            ← Thread tracker with file locking
│   │   └── CONVENTIONS.md        ← Injected into all child agent system prompts
│   ├── agent/                    ← Extension loaded by child agents (worker, reviewer, etc.)
│   │   ├── index.ts              ← Entry point — wires up relay, cutoff, tools, messaging
│   │   ├── relay.ts              ← Writes JSON status to /tmp for parent monitoring
│   │   ├── cutoff.ts             ← Context usage monitor + soft/hard reminders
│   │   ├── tools.ts              ← agent_new_session + agent_reload (tmux injection)
│   │   ├── prompt.ts             ← System prompt injection (identity, conventions, agent dir)
│   │   └── package.json          ← Pi package manifest for the agent extension
│   └── manager/                  ← Extension loaded by the manager/orchestrator
│       ├── index.ts              ← Entry point — wires up messaging, config, monitor
│       ├── config-tools.ts       ← Tools: agent_config_dump/get/set, agent_acl_get/set
│       ├── monitor.ts            ← manager_monitor tool (start/next/stop loop + countdown)
│       ├── package.json          ← Pi package manifest for the manager extension
│       ├── manager.json          ← Manager config (cutoff %, monitor interval/turns)
│       ├── SYSTEM.md             ← Manager's system prompt (role definition)
│       ├── AGENTS.md             ← Mutable learnings (manager updates this itself)
│       ├── MONITOR.md            ← Monitor loop instructions (read each cycle)
│       ├── FINDINGS.md           ← Monitor findings log (updated each cycle)
│       └── CONTEXT_CUTOFF.md     ← What to do when context is running out
├── tmux/                         ← FROM: developer-mode extension (the big dependency)
│   ├── tmux-manager.ts           ← TmuxManager class — spawn, send, inject, capture, etc.
│   ├── tmux-watcher.ts           ← TmuxWatcher — polls for working→idle transitions
│   ├── child-relay.ts            ← Lightweight extension injected into child pi sessions
│   ├── dev-tmux-tools.ts         ← Tool registrations for all pi_dev_tmux_* tools
│   ├── dev-tmux-watch-tools.ts   ← Tool registrations for watch/unwatch + relay events
│   ├── process-tracker.ts        ← ProcessTracker — persistent state for managed sessions
│   ├── truncate-response.ts      ← Shared response truncation utility
│   └── config.ts                 ← DeveloperModeConfig — terminal detection, socket prefix
├── processes/                    ← FROM: processes package (standalone pi package)
│   └── processes.ts              ← Background process management tools
├── sleep-until/                  ← FROM: sleep-until package (standalone pi package)
│   └── sleep.ts                  ← sleep + until tools with countdown widget
├── questionnaire/                ← FROM: questionnaire package (standalone pi package)
│   └── questionnaire.ts          ← Interactive question/answer overlay tool
├── launcher/                     ← Agent launch infrastructure
│   └── launch.sh                 ← Shell script to spawn isolated pi agents in tmux
├── config/                       ← Example configuration files
│   ├── acl.json                  ← Central ACL — who can message who + agent briefs
│   ├── gitignore-example         ← Recommended .gitignore for the agents directory
│   └── agents/                   ← Per-agent configuration examples
│       ├── worker/               ← agent.json, SYSTEM.md, AGENTS.md, CONTEXT_CUTOFF.md
│       ├── reviewer/
│       ├── researcher/
│       └── prototyper/
```

---

## How the System Works

### Two Extension Entry Points

1. **`core/manager/index.ts`** — Loaded by the human operator's pi session (the "manager").
   Registers messaging, config tools, monitor loop, and prompt injection.

2. **`core/agent/index.ts`** — Loaded by each child agent (worker, reviewer, etc.).
   Registered via `launch.sh` which sets env vars and runs pi with `--no-extensions -e <agent-home>`.

### Communication

- **Messaging** (`core/shared/messaging.ts`) — Filesystem-based inbox/outbox. Agents write
  `.md` files to each other's `mailbox/<name>/inbox/` directory. A 1-second polling loop
  detects new messages and injects them into the conversation.
  
- **ACL** (`core/shared/acl.ts`) — Central `acl.json` controls who can talk to who.
  Prevents uncontrolled agent-to-agent chatter.

- **Threads** (`core/shared/threads.ts`) — Thread tracker with file locking to prevent
  race conditions. Enforces max 100 messages per thread (loop protection).

### Agent Lifecycle

1. Manager spawns a tmux session (via tmux tools)
2. Inside tmux, `launch.sh` runs, which:
   - Reads `agent.json` for provider/model/thinking config
   - Sets up an isolated `PI_CODING_AGENT_DIR` (agent's home)
   - Copies auth credentials
   - Assembles system prompt from SYSTEM.md + AGENTS.md
   - Launches pi with `--no-extensions --no-skills` + only the agent extension
3. Agent extension registers messaging, relay, cutoff, and self-management tools
4. Manager monitors via relay status files + tmux capture + messaging

---

## Dependency Analysis — What Needs Separation

### ✅ Already Self-Contained (no external deps beyond pi core)

| Module | External Imports |
|--------|-----------------|
| `core/shared/acl.ts` | `fs`, `path` only |
| `core/shared/threads.ts` | `fs`, `path` only |
| `core/shared/messaging.ts` | pi `ExtensionAPI`, `@sinclair/typebox`, `@mariozechner/pi-ai` (StringEnum) |
| `core/agent/relay.ts` | pi `ExtensionAPI`, `fs` only |
| `core/agent/cutoff.ts` | pi `ExtensionAPI`, `fs` only |
| `core/agent/prompt.ts` | pi `ExtensionAPI`, `fs`, `path` |
| `core/agent/tools.ts` | pi `ExtensionAPI`, `@sinclair/typebox`, `child_process` |
| `core/agent/index.ts` | Wires up the above — no external deps |
| `core/manager/config-tools.ts` | pi `ExtensionAPI`, `@sinclair/typebox`, `@mariozechner/pi-ai`, `fs` |
| `core/manager/monitor.ts` | pi `ExtensionAPI`+`ExtensionContext`, `@sinclair/typebox`, **`@mariozechner/pi-tui`** (`Text`, `visibleWidth`) |
| `core/manager/index.ts` | Wires up the above — no external deps |

**Pi core deps** (always available, not a concern):
- `@mariozechner/pi-coding-agent` — ExtensionAPI, ExtensionContext
- `@sinclair/typebox` — Type schema builder
- `@mariozechner/pi-ai` — StringEnum helper
- `@mariozechner/pi-tui` — Text, visibleWidth (only in monitor.ts countdown)

### 🔴 Runtime Dependencies — Tools the Manager Needs from Other Extensions

These are tools that the manager agent **uses at runtime** but are **not registered by the
agents code**. They come from separate extensions loaded alongside.

#### 1. Tmux Tools (from developer-mode) — CRITICAL

The manager needs these to launch and manage agent sessions:

| Tool | What it does | Source file |
|------|-------------|-------------|
| `pi_dev_tmux_spawn` | Create tmux sessions for agents | `tmux/dev-tmux-tools.ts` |
| `pi_dev_tmux_send` | Send keystrokes to agent sessions | `tmux/dev-tmux-tools.ts` |
| `pi_dev_tmux_inject` | Multi-line content injection | `tmux/dev-tmux-tools.ts` |
| `pi_dev_tmux_capture` | Read agent session output | `tmux/dev-tmux-tools.ts` |
| `pi_dev_tmux_attach` | Open terminal window for user to watch | `tmux/dev-tmux-tools.ts` |
| `pi_dev_tmux_close` | Kill agent sessions | `tmux/dev-tmux-tools.ts` |
| `pi_dev_tmux_list` | List active sessions | `tmux/dev-tmux-tools.ts` |
| `pi_dev_tmux_reload` | Self-reload via tmux | `tmux/dev-tmux-tools.ts` |
| `pi_dev_tmux_new` | Self-new-session via tmux | `tmux/dev-tmux-tools.ts` |
| `pi_dev_tmux_watch` | Watch for child turn-end events | `tmux/dev-tmux-watch-tools.ts` |
| `pi_dev_tmux_unwatch` | Stop watching | `tmux/dev-tmux-watch-tools.ts` |

**Dependency chain:**
```
dev-tmux-tools.ts
  └── tmux-manager.ts (TmuxManager class)
  │     └── config.ts (DeveloperModeConfig, resolveTerminal)
  │     └── process-tracker.ts (ProcessTracker — persistent state)
  └── truncate-response.ts (response size limiting)

dev-tmux-watch-tools.ts
  └── tmux-watcher.ts (TmuxWatcher class)
  │     └── tmux-manager.ts (for capture)
  └── truncate-response.ts
```

**Why this is the biggest problem:**
- `tmux-manager.ts` depends on `config.ts` which is developer-mode's full config system
  (terminal detection, socket prefix, spawn args, staleness settings)
- `process-tracker.ts` is a general-purpose tracker used by developer-mode for both
  tmux sessions AND spawned subprocesses — agents only need the tmux subset
- The tool names are prefixed `pi_dev_*` — not agent-specific

**What to do:** Extract a simplified tmux manager. Strip out config.ts dependency
(hardcode socket prefix, inline terminal detection). Rename tools from `pi_dev_tmux_*`
to something agent-specific. Slim down process-tracker to only track tmux sessions.

#### 2. Sleep/Until (from sleep-until package) — MEDIUM

| Tool | What it does |
|------|-------------|
| `sleep` | Countdown timer between actions |
| `until` | Repeating check loop (start/next/resolve) |

**Note:** The manager's `monitor.ts` already has its OWN countdown implementation
(duplicated from sleep-until). The `sleep` and `until` tools are referenced in system
prompt instructions and used for ad-hoc waiting/polling.

**What to do:** Either bundle a lightweight sleep/until or declare as peer dependency.
The monitor countdown is already self-contained.

#### 3. Processes (from processes package) — LOW

| Tool | What it does |
|------|-------------|
| `process_start` | Start background commands |
| `process_stop` | Stop background commands |
| `process_status` | Show status |
| `process_tail` | Read output |
| `process_grep` | Search output |
| `process_ports` | Show listening ports |
| `process_health` | Health probe status |

**Usage:** The manager can use these for monitoring build servers, test runners, etc.
Not strictly required for agent orchestration — agents are launched via tmux, not processes.

**What to do:** Keep as optional peer dependency. Not needed for core agent orchestration.

#### 4. Questionnaire (from questionnaire package) — LOW

| Tool | What it does |
|------|-------------|
| `questionnaire` | Interactive UI for asking user questions |

**Usage:** Used when agents need human input. The relay system detects when a child
agent calls questionnaire and marks it as "blocked".

**What to do:** Keep as optional peer dependency.

#### 5. Web Search (from web-search package) — NONE

Referenced in individual agent.json files as per-agent extensions. Not loaded by the
agents framework itself. Each agent independently loads web-search. No framework dependency.

---

## Key Files to Understand

### `core/agent/tools.ts` — Self-Management via tmux
The child agents use `execSync` to send tmux commands to their own session (`/new`, `/reload`).
This reads `TMUX` and `TMUX_PANE` env vars — works because agents run inside tmux sessions.
**No dependency on developer-mode** — direct tmux commands.

### `core/agent/relay.ts` vs `tmux/child-relay.ts` — DUPLICATE
Both write JSON status to `/tmp/pi-relay-<id>.json`. The agent's `relay.ts` is loaded via
the agent extension; `child-relay.ts` was developer-mode's standalone version injected via
`-e` flag. **These do the same thing.** The agent framework uses `relay.ts`. The
`child-relay.ts` is only needed if you want relay without the full agent extension.

### `tmux/tmux-watcher.ts` — Two Detection Methods
1. **Visual heuristic** — scans tmux pane for spinner characters (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏) vs
   separator lines (─────). Fallback when no relay is active.
2. **Relay-driven** — reads `/tmp/pi-relay-<id>.json` for state transitions (working→idle).
   More reliable, used when relay is enabled.

### `launcher/launch.sh` — Agent Isolation
Critical script. Creates per-agent home directories, copies auth, generates package.json
with the right extensions, assembles system prompt, and launches pi with full isolation.
Uses env vars: `AGENT_NAME`, `PI_RELAY_ID`, `AGENT_DIR`, `AGENTS_DIR`, `CONTEXT_CUTOFF_PCT`.

---

## Refactoring Plan — Priority Order

### 1. 🔴 Inline Tmux Management
- Take `tmux-manager.ts` and strip the `config.ts`/`DeveloperModeConfig` dependency
- Hardcode sensible defaults (socket prefix `/tmp/pi-agent`, auto-detect terminal)
- Simplify `process-tracker.ts` to only track tmux sessions (remove spawn support)
- Move tmux tool registrations into the manager extension directly
- Rename tools from `pi_dev_tmux_*` to `agent_tmux_*` or similar
- Keep `truncate-response.ts` as a simple utility (it's 30 lines)

### 2. 🟡 Bundle Sleep/Until
- The monitor already has its own countdown — no dependency there
- For the `sleep` and `until` tools, either:
  - Bundle a slim version (the core is ~150 lines without the /sleep and /until commands)
  - Or declare as peer dependency with clear docs

### 3. 🟢 Declare Optional Dependencies
- `processes` → optional, for background task monitoring
- `questionnaire` → optional, for human interaction
- `web-search` → per-agent, configured in agent.json

### 4. 🟢 Clean Up
- Remove `child-relay.ts` (redundant with `core/agent/relay.ts`)
- Remove developer-mode's `config.ts` (not needed once tmux is inlined)
- Add proper package.json at root with pi manifest
