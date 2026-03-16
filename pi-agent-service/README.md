# pi-agent-service

Standalone agent service that manages SDK agent sessions for the pi agent framework.

## Development

```bash
cd pi-agent-service
npm install
```

### Type checking

```bash
npm run check    # tsc --noEmit
```

### Unit tests

```bash
npm test         # 61 tests across all modules
```

### Integration test

```bash
npm run test:integration   # Full socket test (no API keys needed)
```

### Start the service

```bash
npm start -- --project /path/to/project
```

## Architecture

```
src/
├── index.ts              ← CLI entry point (PID file, singleton, shutdown)
├── types.ts              ← All core interfaces
├── manager.ts            ← AgentManager — ties everything together
├── settings.ts           ← SettingsLoader (fs.watch, default merging)
├── trace.ts              ← TraceWriter (append-only JSONL)
├── router.ts             ← MessageRouter (ACL, threading, queue)
├── health.ts             ← HealthMonitor (token gap detection)
├── cutoff.ts             ← CutoffMonitor (polite/hard thresholds)
├── subscriptions.ts      ← SubscriptionManager (manager-only)
├── prompt-builder.ts     ← System prompt assembly per turn
├── agent-tools.ts        ← 5 customTools per agent
├── recovery.ts           ← State recovery from trace.jsonl
├── session-factory.ts    ← (placeholder)
└── adapters/
    └── unix-socket.ts    ← NDJSON protocol over Unix socket
```

## Config files

On first run, auto-creates `.pi/agents/` with:
- `settings.json` — service config, defaults, ACL, agent paths
- Per-agent: `agent.json`, `SYSTEM.md`, `AGENTS.md`
- `trace.jsonl` — append-only audit log
- `LOOP_INSTRUCTIONS.md`, `DEFERRED.md` — manager loop files
