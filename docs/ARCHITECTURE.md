# Whaser — Architecture

Whaser is an AI-driven system for **creating WhatsApp agents**. A user designs an agent
through a guided **conversation**, Whaser stores a concrete **AgentSpec**, and runs that
agent **always-on** against inbound WhatsApp messages under a **non-personal business
identity**, with directory-style (LDAP) multi-tenant user management and a GUI listing all
agents.

This document is the technical companion to the approved POC plan. See
[`ROADMAP.md`](./ROADMAP.md) for the phased build and [`SETUP.md`](./SETUP.md) for the
operational runbook.

## Foundation: extend LibreChat

Whaser is built **on top of LibreChat** (MIT), pinned to **v0.8.6** (included as the
`librechat/` git submodule). LibreChat gives us, for free:

- **Auth & RBAC** — local, OAuth, OIDC, SAML, **LDAP**, 2FA, multi-user roles.
- **Agent runtime** — a Claude-first agent execution loop with native **MCP** + tools + actions.
- **Agent model + agent-list UI** and a **chat UI** (reused for the wizard + sandbox preview).
- **Token-usage transactions** (reused for the per-tenant cost ledger).

Whaser additions live in clearly separated modules to keep upstream merges sane (pin a
version; minimize core edits). LibreChat is **MongoDB**-based, so multi-tenant isolation is
**app-level scoping** (a `tenantId` on records), not Postgres RLS.

## Topology

```
                 Internet (HTTPS, real DNS name)
                          │
                ┌─────────▼──────────┐  Caddy: automatic Let's Encrypt TLS
                │  Caddy reverse proxy│  (valid CA cert required by the Cloud API webhook)
                └──────────┬──────────┘
   / (SPA), /api (LibreChat), /api/whatsapp/webhook (GET verify + POST inbound)
                           ▼
   ┌──────────────────────────────────────────────────────────────┐
   │        LibreChat (Node/Express API + React client) — FORK      │
   │  INHERITED (reuse):            NEW (Whaser modules):            │
   │  • LDAP/OIDC/SAML auth + RBAC  • whatsapp gateway (Cloud API)   │
   │  • Claude + MCP agent runtime  • inbound worker + durable queue │
   │  • Agents model + list UI      • create-agent WIZARD (UI + svc) │
   │  • token-usage transactions    • tenant scoping + budgets       │
   │  • chat UI (wizard + sandbox)  • phone_number_id → agent route   │
   │                                • AgentSpec + spec versioning     │
   └──────┬──────────────────────────────────────┬─────────────────┘
          │ Mongoose                               │ LDAP bind
          ▼                                        ▼
   ┌────────────────┐   Meilisearch (search) ┌───────────────┐
   │   MongoDB       │   vectordb (RAG)        │     lldap      │  Rust LDAP directory,
   │ users, agents,  │                         │ users / groups │  web admin UI, GraphQL
   │ specs, WA jobs, │                         │ memberOf       │
   │ convos, tenants,│                         └───────────────┘
   │ usage           │
   └────────────────┘
   Anthropic API (Claude)   ·   Uptime-Kuma (GUI + webhook + token-expiry probe)
   nightly encrypted mongodump → off-box
```

## Connectivity model (headless-friendly)

Meta POSTs inbound messages to `/api/whatsapp/webhook`. Whaser:

1. answers the `GET` verify-token challenge (one-time webhook registration),
2. verifies the `X-Hub-Signature-256` HMAC on every `POST`,
3. **ACKs `200` immediately**,
4. enqueues an `inbound_jobs` row (dedupe on `wa_message_id`),
5. a worker leases the job, resolves `phone_number_id → agent`, runs the agent, and replies
   asynchronously via Graph API `POST /{phone-number-id}/messages`, recording `reply_sent`
   for idempotency.

No long-lived socket, no QR, no auth-state file. The **only** always-on credential is the
Meta **long-lived System User token**.

## Runtime engine

- **Runtime replies** drive **LibreChat's existing Claude+MCP agent runtime** server-side per
  inbound message. (This server-side invocation is the Phase 3 integration spike — see the
  fallback in `ROADMAP.md`.)
- The **wizard's** structured extraction/synthesis calls are made directly via
  `@anthropic-ai/sdk` (we need strict structured output), separate from the chat pipeline.

## Models (Anthropic Claude)

| Role | Model | ID |
|---|---|---|
| Builder interview/extraction; runtime conversational replies | Sonnet 4.6 | `claude-sonnet-4-6` |
| Final AgentSpec synthesis; hard-reasoning agents | Opus 4.8 | `claude-opus-4-8` |
| Cheap intent/spam classification (only where measured to beat a rule-based gate) | Haiku 4.5 | `claude-haiku-4-5` |

**API conventions** codified in one shared helper: structured output via `messages.parse()` /
`output_config.format` (json_schema; `additionalProperties:false`, no min/max/length, no
recursion — see [`../schemas/agent-spec.schema.json`](../schemas/agent-spec.schema.json));
adaptive thinking only (`thinking:{type:"adaptive"}`, never `budget_tokens`); no
last-assistant prefills; stream when `max_tokens` > ~16K; check `stop_reason==='refusal'`
before reading content; prompt-cache the byte-stable system prompt + tool list and inject
volatile state after the last cache breakpoint.

## Data model (MongoDB / Mongoose) — Whaser collections

Reuse LibreChat's `users`, `agents`, `conversations`, `messages`, `transactions`; add the
following, all tenant-scoped with a `tenantId`:

| Collection | Key fields | Purpose |
|---|---|---|
| `tenants` | `_id`, `name`, `ldapGroupDn` | Team/tenant = lldap group. |
| `agentSpecs` | `agentId`, `version`, `specJson`, `createdAt` | Versioned, append-only AgentSpecs. |
| `waNumbers` | `phoneNumberId`, `agentId`, `tenantId`, `displayName`, `status` | Inbound `phone_number_id → agent` routing; one number per agent. |
| `waConversations` | `agentId`, `senderHash`, `libreChatConversationId`, `lastInboundAt` | Per-(agent,sender) thread mapped to a LibreChat conversation; `senderHash` = hashed phone. |
| `waJobs` | `waMessageId`(unique), `payload`, `status`, `replySent`, `attempts`, `lockedAt` | Durable inbound queue; crash-safe; idempotent reply send; dedupe. |
| `usageBudgets` | `tenantId`, `day`, `tokensIn/Out`, `estCostUsd`, `cap` | Per-tenant spend + circuit-breaker budgets. |

Correlation id flows `waMessageId → waJobs → messages → Meta delivery status`.

## The "Create new agent" conversational flow

A deterministic **slot-filling state machine** (the app decides the next question and when the
spec is complete; Claude extracts/synthesizes, it does not free-run):

`GREETING → SLOT-FILL loop (ask one Q · extract via strict tool use · validate · persist) →
CONFIRMATION (read-back) → SYNTHESIS (Opus 4.8, messages.parse) → CONSISTENCY CHECK (scope
disjoint · every tool has an executor · persona/goal coherent) → SANDBOX PREVIEW (chat the
draft, tools stubbed, no WhatsApp) → PUBLISH (versioned spec materialized as a LibreChat
agent + WhatsApp metadata)`.

Target slots and the emitted spec shape are defined in
[`../schemas/agent-spec.schema.json`](../schemas/agent-spec.schema.json).

## Security & always-on

- **Webhook:** HMAC verify every POST; ACK 200 fast; dedupe on `waMessageId`.
- **Cost/abuse circuit-breaker** before any model call: per-sender + per-agent rate limits,
  max inbound size, hard daily per-tenant token budget, global kill-switch.
- **Tool safety:** inbound text is data, not instructions; per-AgentSpec tool allowlist;
  tools read-only/stubbed by default; `side_effecting` tools need a capability flag +
  human-in-the-loop and run sandboxed.
- **Secrets:** root-only `chmod 600 .env`; Pino redaction; SOPS+age when shared.
- **Always-on:** Docker Compose `restart: unless-stopped`; no WhatsApp session state; the
  long-lived token is a Phase-2 gate + Uptime-Kuma expiry probe; durable queue + idempotent
  send survive crashes and Meta retries.
- **Data protection (default ON):** retention (default 30 days) + purge; hashed sender
  numbers; nightly **encrypted** `mongodump` off-box with a drilled restore; per-sender
  erasure; disk encryption on the VM.
