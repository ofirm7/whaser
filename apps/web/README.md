# @whaser/web — local demo GUI

A **self-contained, credential-free** Whaser app that serves the GUI and exercises the real
Whaser backend packages end-to-end. It lets you click through all five POC requirements now,
before wiring real WhatsApp + Claude credentials.

## What's real vs stubbed

| Real (the actual Whaser code) | Stubbed (external boundary only) |
|---|---|
| `@whaser/agent-builder` — slot-filling interview, AgentSpec **schema validation** (ajv) + **consistency checks** + **materializer** | `StubLlmClient` — deterministic extraction/synthesis instead of Claude (no `ANTHROPIC_API_KEY` needed) |
| `@whaser/whatsapp-gateway` — `AgentResolver`, **CircuitBreaker** (rate/budget/kill-switch), `ConversationStore`, `createAgentReplyHandler`, `hashSender` | `StubAgentRuntime` — persona-derived replies instead of the LibreChat agent runtime |
| Tenant scoping + ownership, session auth | In-memory directory instead of lldap (`src/directory.ts`) + simulated WhatsApp transport |

So the wizard produces a genuinely schema-valid, consistency-checked AgentSpec, and the
"WhatsApp" messages flow through the real resolver → cost/abuse breaker → conversation store.

## Run

```bash
cd apps/web
npm install
PORT=8080 npm start     # → http://0.0.0.0:8080
```

Log in as `alice` / `bob` (tenant **Acme**) or `carol` (tenant **Globex**) — password `password`.

## Requirements covered

1. **Non-personal WhatsApp profile** — each published agent gets its own number id (`SIM-####`); the simulator routes by it.
2. **Always-on, headless** — a long-running Node server (production: the Docker stack in `deploy/`).
3. **Conversational create-agent wizard** — `/create`: a guided chat that emits the AgentSpec.
4. **LDAP-like multi-tenant users** — directory login; agents are tenant-scoped (Globex can't see Acme's).
5. **Agents area** — `/agents`: dashboard of every agent with status, bound number, last activity, drill-down + WhatsApp simulator.

## Connect it to Claude (live AI)

Set `ANTHROPIC_API_KEY` and the app **automatically** switches from the stubs to real Claude —
the wizard's extraction (Sonnet 4.6) + AgentSpec synthesis (Opus 4.8) via `AnthropicLlmClient`,
and the simulator's replies via a direct Claude runtime. The header shows **● Claude** vs **● Demo**.

```bash
# either an env var…
ANTHROPIC_API_KEY=sk-ant-... PORT=8080 npm start

# …or a gitignored file the server auto-loads:
echo 'ANTHROPIC_API_KEY=sk-ant-...' > apps/web/.env
PORT=8080 npm start
```

Nothing else changes — same GUI, same code paths, now backed by Claude.

## Going to full production (LibreChat fork)

The demo's direct Claude runtime is the `@anthropic-ai/sdk` fallback path. For the full system,
back the stores with MongoDB and swap the simulator's runtime for `LibreChatAgentClient` +
`CloudApiGateway` (real WhatsApp). See `docs/PHASE3-BRIDGE.md`, `docs/PHASE4-WIZARD.md`, `docs/SETUP.md`.
