# Phase 4 — Conversational "Create new agent" wizard (backend)

Whaser's differentiator: design a WhatsApp agent through a **guided conversation** that emits a
precise, schema-valid, consistency-checked **AgentSpec** — not a visual flow canvas or a form.
This is the backend, built as `packages/agent-builder` and fully unit-tested. The browser UI and
the WhatsApp **sandbox preview** reuse LibreChat's chat surface and call this backend.

## Flow

```
GREETING → SLOT-FILL loop ───────────────→ CONFIRMATION → SYNTHESIS → SCHEMA + CONSISTENCY → (sandbox) → PUBLISH
            ask one question                read-back     Opus 4.8     ajv + programmatic       materialize as
            extract via strict tool use                   messages.    checks                   a LibreChat agent
            (Sonnet 4.6) → validate → store               parse()
```

The app owns the flow (decides the next question, when complete); Claude only **extracts** and
**synthesizes**. No free-running agent in the builder.

## Modules (`packages/agent-builder/src`)

| File | Responsibility |
|---|---|
| `schema.ts` | Loads the canonical `schemas/agent-spec.schema.json` (single source of truth) + `AgentSpec` TS types. |
| `slots.ts` | The interview: ten ordered slots, `nextMissingSlot`, per-slot validation (text non-empty; lists may be empty = "none"). |
| `session.ts` | `nextPrompt` (ask → confirm), `submitAnswer` (validated merge), `summarize` read-back. |
| `llm.ts` | `LlmClient` interface + `AnthropicLlmClient`: strict-tool-use **extraction** (Sonnet 4.6) and `output_config.format` **synthesis** (Opus 4.8, adaptive thinking, refusal-checked). Behind a minimal `AnthropicLike` seam so the SDK is injected (and faked in tests). |
| `validate.ts` | `validateAgentSpec` — ajv (draft 2020-12) against the canonical schema. |
| `consistency.ts` | `checkConsistency` — the "usable, not just valid" gate: scope disjoint, no duplicate/unnamed tools, every tool has a registered executor (when `knownExecutors` given), non-empty goal/greeting/fallback. |
| `materialize.ts` | `toLibreChatAgent` — compiles the spec into one byte-stable `instructions` block + model + tools + Whaser metadata (the AgentSpec → LibreChat mapping from `AI-FEATURES.md`). |
| `builder.ts` | `AgentBuilder` orchestrator: `start()` → `submitText()` (drive the interview) → `finalize()` (synthesize + validate + check → `publishable`). Pure of transport/UI. |

## Verification (run here)

`npm run typecheck` clean; **`npm test` → 29/29** (slots/session/validate/consistency/materialize,
the LLM client's request shape + parsing + refusal handling via a faked Anthropic, and the full
interview → finalize flow incl. inconsistent and schema-invalid specs).

The pure logic is tested without any LLM. **Live synthesis needs an `ANTHROPIC_API_KEY`** — wire a
real client by passing `new Anthropic({ apiKey })` (cast to `AnthropicLike`) into `AnthropicLlmClient`.

## Remaining Phase-4 work (on the VM / in the LibreChat client)

- **Wizard UI** in the LibreChat React client (reuse the chat surface; render `nextPrompt`, send answers).
- **Sandbox preview**: run the draft spec against the runtime (tools stubbed, no WhatsApp) before publish.
- **Publish**: persist the versioned AgentSpec and create the LibreChat agent from `toLibreChatAgent(spec)`
  (then Phase 3's resolver binds a `phone_number_id` to it).
- Wire `knownExecutors` from LibreChat's available tools/MCP so `tool_no_executor` is enforced for real.
