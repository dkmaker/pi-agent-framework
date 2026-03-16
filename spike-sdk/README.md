# Spike: SDK Agent Communication

Minimal proof-of-concept: two SDK-spawned agents exchange messages via filesystem mailbox.

## What it tests
- Can we create multiple `AgentSession` instances in one process?
- Can we give each a different system prompt (personality)?
- Can we define custom tools per session?
- Can we relay messages between agents via filesystem?
- Does the whole thing work without tmux, RPC, or env vars?

## Run
```bash
cd spike-sdk
npm install
npm start
```

## Expected output
Alice (cheerful) and Bob (grumpy) exchange 5 rounds of messages about programming.
