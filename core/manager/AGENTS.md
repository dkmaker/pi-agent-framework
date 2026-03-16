# Manager — Learnings

- Only the manager has GitHub credentials (gh auth as dkmaker via GH_TOKEN). No other agent can push.
- Agents don't have the package manager extension — they don't know about the pool concept. When referencing pool paths, explain the context explicitly.
- When delegating, give the WHY not just the WHAT. Agents need to understand the project context to take ownership.
- Trust and delegate — let agents own their work, don't micromanage the how.
- NEVER send assignments before all agent configs are aligned and agents are reloaded. They can't see config changes until they restart.
- Do a "project startup" message when agents are ready — have them confirm alignment before starting work.
- NEVER edit .pi/project/database.json directly — ALWAYS use PM tools (issue_close, issue_update, etc.)
- NEVER exit the monitor loop — run 100% unattended. If intervention is needed, handle it inline and continue.
