# Whaser — AI Features

How Whaser uses Claude and the broader AI-feature surface. This document is grounded in the verified 2026 Claude API/platform docs, the Anthropic Claude Agent SDK, production AI-system patterns, and the LibreChat v0.8.6 features Whaser inherits. It is the AI-capability companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md) and [`ROADMAP.md`](./ROADMAP.md); phase numbers reference the roadmap (0 scaffold, 1 LDAP auth, 2 WhatsApp echo gateway, 3 bridge WhatsApp↔runtime, 4 create-agent wizard, 5 dashboard + multi-tenant, 6 hardening/DR/observability).

> Key Claude API specifics in this doc (model IDs, structured outputs, adaptive thinking, the citations↔structured-outputs incompatibility, and the prompt-cache minimum prefix) were cross-checked against the bundled `claude-api` skill (cached 2026-06-04). The prompt-cache minimum prefix is **Opus 4.8 = 4096 tokens, Sonnet 4.6 = 2048 tokens** (a research draft had said 1,024 — corrected here).

## How Whaser uses Claude

Whaser is an AI-driven system for *creating* WhatsApp agents, built on a LibreChat fork. Claude appears at two clearly separated surfaces, plus a set of cross-cutting safety/cost controls:

1. **The "Create new agent" wizard (Phase 4)** — a deterministic slot-filling state machine that interviews the user. Slots are extracted with **strict tool use** (Sonnet 4.6); the final versioned **AgentSpec** is synthesized with **structured outputs** (`messages.parse()` / `output_config.format`) on **Opus 4.8**. This call runs directly via `@anthropic-ai/sdk` (not the chat pipeline) because it needs guaranteed JSON-schema conformance against [`../schemas/agent-spec.schema.json`](../schemas/agent-spec.schema.json). Structured outputs is the single most load-bearing AI feature for the builder.
2. **The WhatsApp runtime (Phase 3)** — each published AgentSpec is materialized onto a LibreChat **Agent** and answers inbound WhatsApp messages via LibreChat's **Claude + MCP** agent runtime (preferably driven headlessly through the **Agents API (Beta)**). The runtime relies on **system prompts** (the rendered AgentSpec), **tool use / MCP**, **prompt caching** of the byte-stable prefix, **adaptive thinking**, **streaming** (timeout protection), and rigorous **stop-reason handling** so an unattended bot never crashes or sends empty messages.
3. **Cross-cutting controls** — a pre-model **cost/abuse circuit-breaker**, "**inbound text is data, not instructions**" injection defense with a default-deny tool allowlist, per-call token/cost capture for the per-tenant ledger, and **escalation-rule-driven** human handoff.

**Model tiers (Anthropic Claude):** Opus 4.8 (`claude-opus-4-8`) for AgentSpec synthesis and hard-reasoning agents; Sonnet 4.6 (`claude-sonnet-4-6`) for the interview and routine conversational replies (default); Haiku 4.5 (`claude-haiku-4-5`) for auto-titles and cheap intent/spam classification only where it measurably beats a rule.

**API conventions** (one shared helper): structured output via `output_config.format` (never assistant prefills — they 400 on Opus 4.8); `thinking:{type:"adaptive"}` only (manual `budget_tokens` 400s on Opus 4.8); no `temperature`/`top_p`/`top_k` on Opus 4.8; stream when `max_tokens` > ~16K; check `stop_reason==='refusal'` before reading content; prompt-cache the frozen system prompt + tool list and inject volatile state after the last cache breakpoint. The cacheable prefix must clear the model minimum (Opus 4.8 = 4096 tokens, Sonnet 4.6 = 2048) or it silently won't cache.

**Two correctness traps to remember:** (a) **citations + structured outputs return a 400** — so citations live only on the runtime answering path, never on the wizard's AgentSpec call; (b) on Opus 4.8/4.7, manual thinking `budget_tokens`, sampling params, and last-assistant-turn prefills all 400.

## Mapping table

### Claude API features

| Feature | What it is | Whaser use | Adopt in POC? | Phase |
|---|---|---|---|---|
| Structured outputs (`output_config.format` / `messages.parse`) | Constrains output to a JSON schema; SDK validates and returns parsed output. GA on Opus 4.8/Sonnet 4.6/Haiku 4.5. No recursion/min-max, `additionalProperties:false`. Incompatible with citations. | The wizard emits the versioned AgentSpec via `messages.parse()` against the schema — guaranteed valid, no parse-retry loop. Also strict tool use for runtime action tools. | Yes | 4 |
| Tool use / function calling | Single `/v1/messages` endpoint; `tool_use` blocks → you execute → `tool_result`. `tool_choice`, `disable_parallel_tool_use`, `strict:true`. | Each AgentSpec `tools[]` entry becomes a runtime tool; the runtime drives the agentic loop. `strict:true` on action tools hitting external systems. | Yes | 3 |
| System prompts | Top-level `system` param defining persona/behavior; cacheable. 2026 adds non-spoofable mid-conversation system messages. | The rendered AgentSpec (persona, goal, scope, escalation) *is* the system prompt. Mid-conversation system messages inject runtime context ("VIP", "after hours → escalate") without breaking the cached prefix. | Yes | 3 |
| Prompt caching | `cache_control:{type:'ephemeral'}`; reads ~0.1× input price. Min cacheable prefix Opus 4.8 = 4096 tokens, Sonnet 4.6 = 2048 tokens. Workspace-isolated. | The per-agent system prompt + tool list is byte-identical on every inbound message — cache it once, ~90% savings on the cached prefix. Keep the prompt frozen (no timestamps/UUIDs); ensure it clears the model minimum. | Yes | 3 |
| Stop-reason handling (incl. refusal) | `stop_reason`: `end_turn`/`max_tokens`/`tool_use`/`pause_turn`/`refusal`/`model_context_window_exceeded`. Check before reading content. | Unattended bot MUST branch: resume on `pause_turn`, continue/raise on truncation, on `refusal` send a safe canned message or trigger escalation rather than send an empty WhatsApp message. | Yes | 3 |
| Adaptive / extended thinking | `thinking:{type:'adaptive'}` — only thinking mode on Opus 4.8; `effort` (low…max) is soft guidance; auto-enables interleaved thinking. | Keep adaptive on so the agent reasons between tool calls; tune `effort` down (FAQ = low) for cost/latency. Config, not a build. Leave thinking display omitted for WhatsApp. | Yes | 3 |
| Streaming | SSE event stream; `messages.stream()` + `get_final_message()`. Required above ~16K `max_tokens` to avoid timeouts. | Bridge default request path — protects long multi-tool turns from request timeouts; assemble the one WhatsApp message via `get_final_message()`. Optional typing indicator. | Yes | 3 |
| PDF + vision input | PDFs/images via `document`/`image` blocks (base64/URL/file_id); pages processed as text + image. | Inbound WhatsApp media (receipt/ID/invoice photo, PDF) read by the agent; also ground agents on tenant PDF manuals. Bridge downloads Cloud API media and passes as a block. | If demo handles media | 3 |
| Citations | `citations:{enabled:true}` on document blocks; returns verifiable source pointers. **Incompatible with structured outputs (400).** | Source-attributed answers from a tenant's policy/FAQ doc in the runtime — never on the wizard's AgentSpec call. | If grounded answers are a demo goal | 4 |
| Files API | Upload once → `file_id`, reference across requests. Beta; per-workspace (aligns with multi-tenant). | Upload a tenant's `knowledge_sources` files once, reference by `file_id` on every message — no re-encoding. Natural backing store for document knowledge sources. | If file-based knowledge in demo | 4 |
| Token counting | `/v1/messages/count_tokens` — free, model-specific estimate. | Pre-flight cost estimate of an AgentSpec's system prompt + knowledge before publish; warn admins; guard context overrun. Use instead of tiktoken. | No | 6 |
| Message Batches API | Async bulk at 50% price; ~1h+ latency; no streaming. | Offline only: bulk-eval AgentSpecs against test conversations, triage historical messages, backfill summaries. Cannot serve live replies. | No | post-POC |
| Web search tool | Server tool; citations always on; `allowed_domains`; $10/1k searches. Console enablement. | Opt-in per-AgentSpec capability for agents needing current info; `allowed_domains` scopes to the tenant's own site. | No | post-POC |
| Code execution tool | Sandboxed Python/bash; persists 30 days; free with web tools else $0.05/hr. Not ZDR-eligible. | Opt-in per-AgentSpec capability for compute (parse a CSV a customer sent, generate a report). Pairs with Files API. Flag ZDR for data-residency tenants. | No | post-POC |
| Memory tool | Client-side `/memories` store; you implement the backend. ZDR-eligible. | Per-contact cross-thread memory (prior issues, preferences). Needs a secured per-tenant store + PII/retention policy. | No | post-POC |
| Computer use | Screenshot + mouse/keyboard control of a desktop. | No fit for a text/media WhatsApp agent. Listed for completeness. | No | post-POC |

### Claude Agent SDK / Skills / MCP

| Feature | What it is | Whaser use | Adopt in POC? | Phase |
|---|---|---|---|---|
| MCP connector / native MCP servers | Remote MCP via `mcp_servers` + `mcp_toolset` (beta `mcp-client-2025-11-20`); LibreChat configures servers in `librechat.yaml` (stdio/http/sse). | Runtime spine: AgentSpec `tools[]` backed by MCP (CRM, calendar, ticketing). The WhatsApp Cloud API is wrapped as an in-process stdio MCP server. Allow/deny per tool scopes which integrations an agent may use. | Yes | 3 |
| In-process MCP — `createSdkMcpServer()` + `tool()` | Custom tools (Zod schema, handler, annotations) bundled into an in-process MCP server — no subprocess/IPC; secrets stay in-process. | Wrap the WhatsApp send action and each AgentSpec tool as in-process executors; `tool.input_schema` → Zod schema, `description` used verbatim. Satisfies "every tool maps to a registered executor". | Conditional on SDK being the runtime | 3 / 4 |
| Tool annotations + `structuredContent` + `isError` | `readOnlyHint`/`destructiveHint` (hints, not enforcement); `isError:true` keeps the loop alive instead of throwing. | `side_effecting:false → readOnlyHint` (batchable); `side_effecting:true → destructiveHint` + HITL/sandbox. Stubbed tools return `isError` so the agent explains the failure instead of crashing the reply. | Conditional | 3 |
| Permission modes + `canUseTool` | `permissionMode` (`dontAsk`/`default`/…); `canUseTool` allow/deny; prefer `allowedTools` allowlist over `bypassPermissions`. | Native home for tool-safety policy: `dontAsk` + an `allowedTools` allowlist derived from the published AgentSpec; `canUseTool` denies side-effecting calls without a capability flag, records spend, enforces rate limits. | Conditional | 3 |
| `query()` agentic loop | Async generator running the full loop; since v0.2.113 spawns a native binary subprocess. | Phase-3 **fallback** runtime engine only — the productized form of "run the loop ourselves". Never run alongside LibreChat's runtime for the same execution. | No (fallback only) | 3 |
| SDK sessions | `resume`/`forkSession`/`sessionId`; filesystem-backed transcripts. | Conceptually maps to `waConversations`, but filesystem transcripts conflict with Whaser's multi-tenant Mongo model — reconstruct context from Whaser/LibreChat storage instead. | No | post-POC |
| Hooks (PreToolUse/PostToolUse/SessionEnd…) | Event callbacks during the loop. | Record per-tool spend, attach correlation ids, finalize budgets — overlaps Phase 6 observability. `canUseTool` covers the POC critical path. Pin SDK version (hook names vary). | No | post-POC |
| Subagents (`AgentDefinition`) | Delegate to isolated child runs with their own context. | A WhatsApp agent is single-persona; multi-subagent is over-engineering. The `AgentDefinition` *shape* is a useful materialization reference (description←goal/scope, prompt←persona, tools←tools[], model←model_assignment). | No | post-POC |
| Agent Skills (`SKILL.md`) | Filesystem capability folders, model-invoked, progressive disclosure. | Could package reusable playbooks / materialize `knowledge_sources` as a skill folder, but filesystem + model-invoked discovery conflicts with the DB-driven multi-tenant model. Fold knowledge into the system prompt for the POC. | No | post-POC |

### AI-system patterns

| Feature | What it is | Whaser use | Adopt in POC? | Phase |
|---|---|---|---|---|
| Untrusted-input-as-data + constrained-tool defense | OWASP LLM01 has no parameterized boundary; durable defense is a fixed pre-validated tool set + delimiting untrusted text. RAG content is also untrusted. | "Inbound text is data, not instructions": a default-deny per-AgentSpec allowlist (side-effecting off by default) *is* the constrained-tool pattern; wrap inbound text + retrieved chunks in data delimiters behind the byte-stable prompt; inbound text never expands the allowlist. | Yes | 3 |
| Spam/abuse + cost circuit-breaker (deterministic first) | Cheap deterministic pre-filter (rate limits, size quota, spike detect, block-by-id) BEFORE any model call; cheap LLM classifier only where it beats the rule. | Highest-ROI safety item (cost is attacker-controllable). Per-sender + per-agent rate limits, max inbound size, hard daily per-tenant token budget, kill-switch, run before any model call. Haiku 4.5 classifier only where measured to beat the rule. | Yes | 2 / 3 |
| Policy/rules at the tool layer (default-deny) | Enforce permissions outside the model at the tool-call boundary; default-deny. OPA/Rego or NeMo at scale. | Lightweight in-app gate driven by the AgentSpec: tool allowlist + `side_effecting` + in/out-of-scope + budget checks. Decision lives in code, not the prompt. Full OPA/NeMo is post-POC. | Yes | 3 |
| Workflow patterns vs autonomous agents (start simple) | Anthropic taxonomy: workflows (chaining/routing/evaluator-optimizer) vs autonomous agents. Start simple. | Wizard stays a deterministic slot-fill workflow with an evaluator-optimizer loop (synthesis → consistency check → re-ask → sandbox). Runtime is a single agent per (agent, sender), not multi-agent. Model routing: Haiku/Sonnet/Opus by intent. | Yes | 4 (wizard) / 3 (runtime) |
| HITL escalation (calibrated autonomy) | Route uncertain/irreversible actions to humans; do NOT gate on raw LLM confidence (RLHF models are most confident when wrong). EU AI Act Art. 14 from Aug 2026. | Escalate off auditable signals: AgentSpec `escalation_rules`, `side_effecting:true`, out-of-scope match, `stop_reason==='refusal'`, low wizard extraction confidence. POC path: trigger → fallback_message + collect_contact / flag. | Yes | 4 |
| Offline evals + LLM-as-judge + trace flywheel | Deterministic checks + LLM-as-judge + trace-based regression; low-scoring traces become fixtures. | Cheap deterministic layer (schema validation + consistency check) is the highest-value POC eval. A small golden set of inbound messages replayed in the sandbox is a demoable add. Full judge pipeline post-POC. | Yes (deterministic layer) | 4 / 6 |
| LLM observability + cost tracing (OTel GenAI) | Per-call spans capturing model/tokens/latency/cost; Langfuse self-hosted fits single-VM. | Adopt OTel GenAI span schema; record tokens-in/out + est cost (incl. cache_read/creation) into `usageBudgets` and the per-tenant ledger; feeds the circuit-breaker and eval flywheel. Per-call capture is required for the Phase 3 budget-cap demo. | Yes (minimal) | 3 / 6 |
| Hybrid retrieval (BM25 + vector) + rerank | Production RAG = lexical + dense fused (RRF), reranked, parent-child chunking. | Back `knowledge_sources` via LibreChat's `rag_api`/vectordb; basic vector retrieval for the POC, attach citations to cite the chunk. Hybrid + RRF + cross-encoder rerank is the post-POC corpus-scale upgrade. | Yes (basic) | 3 |
| Conversation memory + compaction (24h window) | Tiered memory (verbatim recent + summary) or Claude server-side compaction (beta — persist the compaction block). | Each (agent, sender) → a LibreChat conversation; LibreChat's native per-conversation history suffices for the demo. Add compaction/tiered summary only when threads grow long. | No | post-POC |

### LibreChat inherited features

| Feature | What it is | Whaser use | Adopt in POC? | Phase |
|---|---|---|---|---|
| Agents API (Beta) — headless invocation | OpenAI-compatible `POST /api/agents/v1/chat/completions` with `model=<agentId>`; `interface.remoteAgents`. | **De-risks roadmap risk #1**: the inbound worker calls this with the resolved `agentId` instead of the SDK fallback, reusing tools/RAG/MCP/instructions/token accounting. Preferred Phase-3 bridge path. | Yes | 3 |
| Agent instructions (system prompt) | Agent Builder "Instructions" field. | Wizard compiles persona + goal + refusal_policy + escalation_rules + scope + greeting + fallback into one byte-stable `instructions` block. Primary AgentSpec → LibreChat mapping target. | Yes | 4 |
| Agent model & config | Per-agent provider + model + token limits; `allowedProviders`. | `model_assignment` → `provider=anthropic` + model. `librechat.yaml` already pins the three tiers (`fetch:false`). Consider `allowedProviders:[anthropic]`. | Yes | 4 |
| `recursionLimit` / `maxRecursionLimit` | Caps agent steps (25 / 50, already set). | First-line guard against runaway tool loops. Not a cost cap — the pre-call budget breaker still required. | Yes | 3 |
| Built-in tools + `tools` capability | Calculator, search, weather, etc. (enabled in `librechat.yaml`). | Cheap registered executors the wizard offers as non-side-effecting AgentSpec tools — every tool maps to a real executor. | Yes | 4 |
| Actions (OpenAPI → tools) | Tools from an OpenAPI spec; `x-strict`; SSRF-protected via `allowedDomains`. | Path for HTTP AgentSpec tools (booking/CRM). Side-effecting tools route here behind `needs_sandbox` + capability flag. MUST set `allowedDomains` given untrusted inbound text. | Yes | 4 |
| Native MCP servers (`mcpServers`) | Per-server config (stdio/http/sse), `customUserVars`, OAuth. | WhatsApp Cloud API wrapped as an in-process stdio MCP server; home for custom/internal and side-effecting executors. Editing requires a LibreChat restart. | Yes | 3 |
| File Search (RAG / vector store) | Vector indexing of docs; `maxCitations`/`minRelevanceScore`. Uses `rag_api` + vectordb. | `knowledge_sources` of type `url`/large text → File Search so the agent grounds answers. Tune for terse WhatsApp; strip citation noise before sending. | Yes | 4 |
| File Context (text in instructions) | Extracted doc text inlined into instructions (`context` capability). | Small `knowledge_sources` of type `text` (hours, price list) inlined — cheaper and always present. Add `context` to capabilities. | Yes | 4 |
| Agent versioning | Append-only version history + `updatedBy`. | Overlaps Whaser `agentSpecs`. Decision: `agentSpecs` is source-of-truth; LibreChat versions the materialized agent as a side effect of publish. | Yes | 5 |
| ACL sharing / Marketplace / peoplePicker | Per-agent Viewer/Editor/Owner bits; share with users/groups/roles. | ACL groups (backed by lldap groups) = native substrate for tenant isolation. Keep marketplace/public OFF for the POC. | Yes | 5 |
| Anthropic endpoint config | Built-in endpoint; `titleModel`, `streamRate`, pinned models. | Runtime endpoint for every materialized agent; `titleModel=claude-haiku-4-5`, models pinned to the three tiers, key from `ANTHROPIC_API_KEY`. | Yes | 0 |
| Conversations | Persisted threads; auto-title; Meilisearch. | `waConversations` maps each (agent, senderHash) → a LibreChat `conversationId` for per-sender context. Presets superseded by the AgentSpec. | Yes | 3 |
| Memory feature (per-user) | Per-user key/value personalization agent (extra call per chat). | Per-LibreChat-user model conflicts with service-identity + per-sender erasure; extra call complicates cost budgeting. | No | post-POC |
| Code Interpreter | Sandboxed code execution; paid `LIBRECHAT_CODE_API_KEY`. | No clear WhatsApp Q&A use; paid dependency. | No | post-POC |
| Subagents & Agent Chain | Delegate / sequence up to 10 agents. | Over-engineering for one-agent-per-number; multiplies token cost. | No | post-POC |
| Skills / Deferred Tools | `SKILL.md` instruction sets; tools discovered at runtime. | Cost optimizations, not POC requirements; overlap AgentSpec instructions. | No | post-POC |
| Artifacts | Interactive React/HTML/Mermaid output. | No rendering surface on WhatsApp (text/media only). | No | post-POC |

### Whaser-built (not inherited)

| Feature | What it is | Whaser use | Adopt in POC? | Phase |
|---|---|---|---|---|
| Conversational slot-filling wizard + strict synthesis | A guided conversation (state machine) + strict tool-use extraction (Sonnet 4.6) + `messages.parse()` synthesis (Opus 4.8), via `@anthropic-ai/sdk`. LibreChat's Agent Builder is a static form. | Whaser's core differentiator. Output (the AgentSpec) is materialized onto a LibreChat agent using the inherited features above. | Yes | 4 |
| Per-tenant cost budgets / circuit-breaker | Pre-call daily budget cap + per-sender/agent rate limits + kill-switch. LibreChat only records token transactions after the fact. | Runs before any model call on inbound messages; reads LibreChat's ledger for accounting but enforces caps itself. | Yes | 3 |

## How the wizard's AgentSpec maps onto runtime features

The wizard's job is mostly to **map** an AgentSpec onto LibreChat's existing Agent object, not to build a new runtime. At **PUBLISH**, the consistency-checked, schema-valid AgentSpec is materialized as follows:

| AgentSpec field | Materializes as | Runtime feature |
|---|---|---|
| `agent_name` | Agent `name` | LibreChat agent |
| `brand_persona` + `goal` + `refusal_policy` + `escalation_rules` + `greeting` + `fallback_message` + `in_scope_topics`/`out_of_scope_topics` | One byte-stable `instructions` (system prompt) block | System prompts + prompt caching |
| `model_assignment` (`claude-opus-4-8` / `claude-sonnet-4-6` / `claude-haiku-4-5`) | Agent `provider=anthropic` + model | Anthropic endpoint config |
| `tools[]` where `side_effecting=false` | LibreChat built-in tools, OpenAPI Actions, or in-process MCP tools | Tool use / MCP / Actions |
| `tools[]` where `side_effecting=true` | Gated executor — capability flag + HITL + sandbox (`needs_sandbox` routes to the sandboxed executor) | `canUseTool` / policy gate / annotations |
| `tools[].input_schema` | Tool JSON/Zod schema (`additionalProperties:false`, `strict:true`) | Strict tool use |
| `knowledge_sources` type `text` (small) | File Context inlined in instructions | File Context |
| `knowledge_sources` type `url` / large text | File Search (RAG vector store) + citations on answers | File Search / Citations |
| `escalation_rules` | Runtime branch on out-of-scope / `stop_reason==='refusal'` / rule match → fallback + collect_contact / handoff | HITL escalation + stop-reason handling |
| `needs_sandbox` | Route to the sandboxed tool executor vs in-process | Tool safety / permission gate |

Two consistency invariants enforced before publish: **scope is disjoint** (`in_scope_topics` ∩ `out_of_scope_topics` = ∅) and **every tool maps to a registered executor** (no tool the runtime cannot run). The runtime then sits behind the pre-model circuit-breaker, with inbound text wrapped as data, the system prompt + tool list prompt-cached, and per-call tokens/cost recorded into `usageBudgets`.

> Keep the wizard on `@anthropic-ai/sdk` (structured output) and the runtime on LibreChat's Claude+MCP runtime (Agents API). Never run two agentic loops for the same execution.

## Prioritized adoption

### Adopt now (POC)
1. **Structured outputs** for the wizard's AgentSpec synthesis (Phase 4) — the single most load-bearing feature.
2. **Tool use + MCP** (incl. WhatsApp Cloud API as an in-process MCP server) as the runtime spine (Phase 3).
3. **System prompts** — the rendered AgentSpec becomes runtime behavior (Phase 3).
4. **Stop-reason handling** incl. refusal — non-negotiable for an unattended bot (Phase 3).
5. **Prompt caching** of the frozen per-agent prefix — ~90% savings, near-free to enable (Phase 3). Ensure the cached prefix clears the model minimum (Opus 4.8 = 4096 tokens, Sonnet 4.6 = 2048).
6. **Streaming** as the bridge default request path — timeout protection (Phase 3).
7. **Pre-model cost/abuse circuit-breaker** — highest-ROI safety item (Phase 2/3).
8. **Inbound-text-as-data + default-deny tool allowlist** — the constrained-tool injection defense (Phase 3).
9. **LibreChat Agents API (Beta)** — preferred headless bridge; de-risks the runtime spike (Phase 3).
10. **AgentSpec → LibreChat agent mapping** (instructions, model, tools/Actions/MCP, File Search/Context) (Phase 4).
11. **Deterministic eval layer** — schema validation + consistency check + sandbox preview (Phase 4).
12. **Per-call token/cost capture** into the per-tenant ledger; OTel GenAI span schema (Phase 3 minimal, Phase 6 dashboards).
13. **Escalation-rule-driven HITL** — handoff off auditable signals, never raw LLM confidence (Phase 4).
14. **ACL groups for tenant isolation** (backed by lldap), marketplace OFF (Phase 5).
15. *Conditional:* **PDF/vision input**, **citations**, **Files API** — adopt only if the demo handles media or grounded-citation answers (Phase 3/4).

### Defer (post-POC)
- **Token counting** (cost dashboard add-on, Phase 6).
- **Message Batches API** (offline eval/backfill — cannot serve live replies).
- **Web search** and **code execution** tools (opt-in per-AgentSpec capabilities; cost/latency).
- **Memory tool** / LibreChat **per-user memory** (needs a secured per-tenant store + PII policy).
- **Computer use** (no WhatsApp use case).
- **Claude Agent SDK `query()` loop** (fallback runtime only — used solely if the LibreChat headless bridge can't be driven).
- **SDK sessions, hooks, subagents, Agent Skills** (filesystem/multi-agent — conflicts with the DB-driven single-agent model).
- **Hybrid retrieval + reranking + parent-child chunking** (corpus-scale RAG upgrade).
- **Conversation compaction / tiered summary** (cost/latency optimization once threads grow long).
- **Full LLM-as-judge eval pipeline + trace flywheel**, **OPA/Rego / NeMo policy engine**, **approval queue UI** (EU AI Act oversight).
- **Code Interpreter, Agent Chain, Skills/Deferred Tools, Artifacts** (paid dep / no WhatsApp surface / optimizations).
