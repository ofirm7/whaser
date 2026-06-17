# Whaser — POC Roadmap

Phased build from empty repo to a demoable POC. De-risk order: stand up the base → cheap
directory login → **prove the compliant always-on WhatsApp path** → **prove we can drive
LibreChat's runtime from WhatsApp** → wizard → dashboard → harden. Effort estimates are rough
for a single developer.

The five POC requirements:

1. WhatsApp bot profile under a **non-personal** (business/brand) identity.
2. **Always-on** on a remote **headless** Linux VM (no GUI).
3. Web GUI with a guided **conversational "Create new agent"** wizard → concrete spec.
4. **LDAP-like**, multi-tenant user management.
5. GUI area **listing all agents**.

---

- [ ] **Phase 0 — Fork & deploy LibreChat on the VM.** Pin LibreChat v0.8.6 (`librechat/`
  submodule). `deploy/docker-compose.yml` with `caddy` (auto TLS at the real DNS name),
  `api`, `mongodb`, `meilisearch`, `vectordb`, `rag_api`, all `restart: unless-stopped`.
  Configure the Anthropic endpoint + model IDs in `deploy/librechat.yaml`.
  **Done when:** you log in and chat with Claude over HTTPS at the real domain. *(1–2 days)*

- [ ] **Phase 1 — Directory auth (REQ 4 baseline).** Add `lldap`; wire LibreChat's LDAP auth
  against it; seed an admin + 2 tenant groups via the lldap UI.
  **Done when:** users log in via the directory; admin manages users/groups in lldap. *(1–2 days)*

- [ ] **Phase 2 — De-risk WhatsApp identity + connectivity (echo).** Meta app + WhatsApp
  product + **test number**; create a Meta Business Portfolio + System User and mint a
  **long-lived token** (acceptance gate). Build `MessagingGateway` + `CloudApiGateway`: `GET`
  verify, `POST` w/ HMAC verify + ACK 200, durable `waJobs` queue + dedupe, Graph API send.
  Echo bot + Uptime-Kuma token-expiry probe + rate-limit stub.
  **Done when:** messaging the test number from a pre-verified phone echoes back unattended
  over valid TLS, **still works the next day** (long-lived token), and duplicate deliveries
  don't double-reply. *(2–3 days)*

- [ ] **Phase 3 — Bridge WhatsApp ↔ LibreChat agent runtime (SPIKE — top risk).** Resolve
  `phone_number_id → agent`; map (agent,sender) → a LibreChat conversation; **invoke
  LibreChat's agent execution server-side** and reply within the 24h window; wire the
  cost/abuse circuit-breaker + per-tenant budget. Hardcoded agent.
  **Fallback:** if LibreChat's internal run API can't be driven cleanly, run the agent loop
  ourselves via `@anthropic-ai/sdk` + the AgentSpec, still reusing LibreChat for
  auth/RBAC/UI/storage.
  **Done when:** the test number answers in-character via a LibreChat agent, remembers
  context, calls a stubbed tool, and per-agent token spend is recorded; budget caps
  demonstrably stop runaway cost. *(3–5 days, spike-gated)*

- [ ] **Phase 4 — Conversational create-agent wizard (REQ 3).** Wizard UI (reuse chat UI) +
  backend slot-filling (Sonnet 4.6 ask+extract via `strict` tool use; persist
  slots+transcript) → confirmation → Opus 4.8 synthesis via `messages.parse()` → consistency
  check w/ targeted re-ask → **sandbox preview** → publish (versioned spec materialized as a
  LibreChat agent + WhatsApp metadata).
  **Done when:** a user designs an agent in-browser, it passes schema+consistency checks, they
  verify it in a sandbox chat, publish, and bind it to the test number → it goes live. *(4–6 days)*

- [ ] **Phase 5 — Agents dashboard + multi-tenant scoping (REQ 5 + REQ 4 depth).** Extend the
  Agents list with WhatsApp status, bound number, last activity, number-binding UI,
  pause/resume, version history; enforce `tenantId`/owner scoping + roles on all agent/spec
  queries.
  **Done when:** a dashboard lists every agent with drill-down; users see/create only their
  tenant's agents; isolation tests pass. **All five requirements demoable end-to-end.** *(3–4 days)*

- [ ] **Phase 6 — Hardening, DR, observability, demo polish.** Reboot-survival check; nightly
  **encrypted** `mongodump` off-box + **restore drill**; retention purge + per-sender erasure;
  observability (correlation-id `waMessageId → waJobs → messages → Meta delivery`; per-tenant
  spend + latency + refusal/tool-error views); README runbook (Meta setup, token rotation,
  webhook registration, adding a test recipient, **verified display-name path** with owner +
  timeline). *(2–3 days)*

---

## Out of scope for the POC

- Verified brand display name (external dependency — tracked, not built; see `SETUP.md`).
- Outbound/proactive template messaging (runtime stays inside the 24h service window).
- Side-effecting production tools (require sandbox escalation).
- HA / managed DB / multi-VM (single VM + nightly encrypted off-box backup accepted for a POC).

## Top risks

1. **LibreChat runtime bridge (Phase 3)** — driving its chat-UI-centric runtime headlessly per
   WhatsApp message. *Mitigation:* dedicated spike + `@anthropic-ai/sdk` fallback.
2. **Verified brand identity is partly external** — multi-week Meta verification, can be
   rejected. *Mitigation:* run on the test number; track the verified path with an owner.
3. **Meta-side setup has no SLA; temp 24h token breaks always-on.** *Mitigation:* front-load in
   Phase 2; long-lived token is a gate; token-expiry probe.
4. **Attacker-controllable LLM cost** from strangers. *Mitigation:* circuit-breaker before any
   model call; per-agent spend from day one.
5. **Wizard emits valid-but-unusable specs.** *Mitigation:* consistency check + mandatory
   sandbox preview.
6. **PII/data exposure.** *Mitigation:* retention + hashing + encrypted backups, default-on.
7. **Forking a large, fast-moving codebase.** *Mitigation:* pin a version, isolate Whaser
   modules, minimize core edits.
