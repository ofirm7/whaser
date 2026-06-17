# Phase 3 — WhatsApp ↔ LibreChat runtime bridge (spike findings)

The roadmap's #1 risk was whether LibreChat's chat-UI-centric agent runtime can be driven
**headlessly, per WhatsApp message**. This documents the spike result and the bridge built on it.

## Verdict: YES — use LibreChat's Agents API (no `@anthropic-ai/sdk` fallback needed)

LibreChat v0.8.6 ships a first-class, OpenAI-compatible, API-key-authenticated endpoint for
exactly this. Verified against the v0.8.6 source (the `librechat/` submodule), not docs:

- **Endpoint:** `POST /api/agents/v1/chat/completions`
  (`api/server/routes/agents/openai.js`, mounted at `api/server/index.js:216`).
- **Request:** `{ "model": "<agentId>", "messages": [...], "stream": false, "conversation_id"?, "parent_message_id"? }`.
- **Auth (`requireRemoteAgentAuth`):** a LibreChat **agent API key** as `Authorization: Bearer …`
  (`createRequireApiKeyAuth` → `validateAgentApiKey`).
- **Feature gate (`checkRemoteAgentsFeature`):** the caller's role needs the `REMOTE_AGENTS:USE` permission.
- **Per-agent access (`checkAgentPermission`):** the key's user must have access to that agent.
- **Non-streaming response:** standard `chat.completion` —
  `choices[0].message.content` + `usage.{prompt_tokens, completion_tokens}`.

The `@anthropic-ai/sdk` fallback in [`AI-FEATURES.md`](./AI-FEATURES.md) remains the contingency,
but is **not** required: the bridge's `AgentRuntime` interface has one production implementation
(`LibreChatAgentClient`) and the fallback can implement the same interface later if needed.

## The one nuance: conversation continuity

`buildNonStreamingResponse` (`packages/api/src/agents/openai/service.ts`) does **not** return the
`conversation_id`, and passing one requires it to **pre-exist** (`db.getConvo` check,
`controllers/agents/openai.js:212`). So we do **not** rely on LibreChat's conversation id.

**Design:** Whaser owns conversation state. Each `(agentId, senderHash)` thread's message history
lives in Whaser (`InMemoryConversationStore` now → `waConversations`/`messages` in production),
and the full recent history is replayed to the agent each turn (capped to bound tokens within the
24h window). This is robust and matches the stateless request model.

## What the bridge does (per inbound text message)

`createAgentReplyHandler` (the production replacement for `echoHandler`):

1. **Resolve** `phone_number_id → { agentId, tenantId }` (`AgentResolver`; one number per agent).
2. **Hash** the sender's number (`hashSender`, HMAC-SHA256 + salt) — PII never stored raw.
3. **Cost/abuse gate** (`CircuitBreaker`, runs *before* any model call): kill-switch → max size →
   per-tenant daily token budget → per-sender rate limit.
4. **Run** the agent over stored history + the new message (`LibreChatAgentClient.complete`).
5. **Record** `prompt+completion` tokens against the tenant's daily budget.
6. **Persist** the user+assistant turn; **reply** via the existing idempotent gateway worker.

Unrouted number, breaker block, non-text, or empty reply → no reply (job completes, no retry).
Runtime/network errors throw → the worker retries (idempotent send guards against double-reply).

Code: `packages/whatsapp-gateway/src/{agentRuntime,agentResolver,conversationStore,circuitBreaker,senderHash,agentReplyHandler}.ts`.
Tests: 42 vitest cases (`npm test`), incl. LibreChat client contract, breaker windows/budgets, and the handler flow.

## Wiring it on the VM (when LibreChat is up)

1. In `deploy/librechat.yaml`, enable the remote-agents interface:
   ```yaml
   interface:
     agents: true
     remoteAgents: true
   ```
2. Grant the user's **role** the `REMOTE_AGENTS:USE` permission (LibreChat admin / roles config).
3. Create an **agent** (any agent works for the spike; Phase 4's wizard creates them) and an
   **agent API key** for it.
4. Set the Phase-3 env in `deploy/.env`:
   ```
   WHASER_RUNTIME=librechat
   LIBRECHAT_BASE_URL=http://api:3080
   LIBRECHAT_AGENT_API_KEY=<agent api key>
   WHASER_AGENT_ID=<agent id>
   WHASER_TENANT_ID=<tenant/group id>
   ```
5. The standalone gateway (or, in production, the in-LibreChat module) now drives the agent
   instead of echoing.

**Done when:** the test number answers in-character via a LibreChat agent, remembers context,
and per-agent token spend is recorded; tripping the budget cap stops further model calls.

> Local note: the full round-trip needs LibreChat running **and** an `ANTHROPIC_API_KEY` (the
> agent's model call). The bridge logic itself is fully unit-tested here without either; the live
> end-to-end is the on-VM verification step.
