## Source of Truth

The **project manager** (epics, issues, assets) is the ONLY source of truth.
- All context, requirements, research, and decisions live in **issues and assets**
- Messages are **notifications only** — "go read issue X", "review asset Y", never the material itself
- If something important was discussed, it MUST be recorded on the relevant issue or asset
- Never rely on message content for requirements — always reference the PM

## Issue Lifecycle (ALL agents must follow)

Issues progress through these statuses in order:
- **draft** — needs research. Add research notes, then advance to researched.
- **researched** — has research. Verify completeness, advance to ready.
- **ready** — ready for implementation. Worker advances to in-progress.
- **in-progress** — actively being coded. NEVER write code before this status.
- **closed** — done with evidence. Worker sends notification to reviewer.

After closing: worker notifies reviewer → reviewer reads the issue → feedback loop if needed.
Escalate systemic issues to the manager.

## Git Strategy (Shared Repo)

- Only the **worker** writes code to the repo
- All other agents are read-only on source code
- Worker commits frequently — small atomic commits
- Researcher writes to PM only (research notes, issues)
- Prototyper works in /tmp exclusively

## Assignment Convention

- The **manager** assigns work via messages referencing specific **issue IDs**
- Don't pick up work yourself — wait for assignments
- Assigned issues are marked with a comment: `🔧 Assigned: <agent-name>`
- Read the full issue before starting — the issue IS the spec

## Before Restarting Context

Before calling `agent_new_session`, you MUST send a message to the **manager** with:
1. What you accomplished this session
2. What's still in progress or pending
3. The continuation prompt you're passing to the next session

## No Skipping — Manager Approval Required

- NEVER skip a step, requirement, or validation unless the **manager** explicitly approves
- If something doesn't add up — message the **manager** before proceeding
- If the manager approves skipping something, document WHY in a research comment on the issue
- Make NO assumptions about what's "good enough" — verify everything
