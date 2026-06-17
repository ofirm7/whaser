# @whaser/whatsapp-gateway

Phase 2 of Whaser — a **thin, direct WhatsApp Cloud API gateway**. Framework-agnostic core
(no LibreChat dependency) so it can later be mounted into LibreChat's Express app or run as a
sidecar (the Phase 3 integration decision).

## What it does

- **Webhook ingestion** — `GET` verify-token challenge + `POST` inbound, with mandatory
  `X-Hub-Signature-256` HMAC verification over the raw body.
- **Durable inbound queue** — dedupe on `wa_message_id`, lease/complete/fail with retries.
  In-memory implementation for dev/test; production swaps in a MongoDB-backed store.
- **Idempotent reply send** — a `replySent` flag + dedupe guard against Meta's at-least-once
  retries and crash-after-send (so a number never double-replies).
- **Echo worker** — Phase 2 replies with the same text. Phase 3 swaps `echoHandler` for the
  LibreChat agent-runtime handler.

## Layout

| File | Responsibility |
|---|---|
| `src/types.ts` | `MessagingGateway`, `JobStore`, `InboundMessage`, `Job` interfaces. |
| `src/signature.ts` | Constant-time `X-Hub-Signature-256` HMAC verification. |
| `src/cloudApiClient.ts` | `CloudApiClient` (Graph API send) + `parseInboundWebhook`. |
| `src/inboundQueue.ts` | `InMemoryJobStore` (dedupe + lease + retry). |
| `src/worker.ts` | `InboundWorker` + `echoHandler` (idempotent processing). |
| `src/webhook.ts` | Framework-agnostic `verifyChallenge` + `handleInbound`. |
| `src/express.ts` | `createWebhookRouter` (mount at `/api/whatsapp/webhook`). |
| `src/index.ts` | Standalone echo server for local smoke-testing. |

## Develop

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest — 20 tests (signature, queue, webhook, worker)
```

## Local smoke test

```bash
WHATSAPP_VERIFY_TOKEN=verify-123 WHATSAPP_APP_SECRET=secret \
WHATSAPP_ACCESS_TOKEN=dummy WHATSAPP_PHONE_NUMBER_ID=PN_TEST GATEWAY_PORT=3091 \
  npm start
# GET  /api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verify-123&hub.challenge=X  -> X
# POST /api/whatsapp/webhook  (with a valid X-Hub-Signature-256)  -> 200 + enqueue
```

A real echo round-trip requires real Meta credentials and a public HTTPS webhook URL
(see `docs/SETUP.md`, Phase 2). With a dummy token the worker reaches the real Graph API and
gets a `190 Invalid OAuth access token`, which confirms the wiring.

## Not yet wired

- MongoDB-backed `JobStore` (production durability) — interface is defined; impl lands with the
  Phase 3 LibreChat integration.
- `phone_number_id → agent` routing + the LibreChat-runtime handler (Phase 3).
- Cost/abuse circuit-breaker before the handler (Phase 3).
