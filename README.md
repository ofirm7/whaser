# Whaser

**An AI-driven WhatsApp agent creation system.**

Design a WhatsApp agent through a guided **conversation** — describe what it should do, for
whom, and how — and Whaser turns that into a concrete, versioned **AgentSpec**, then runs it
**always-on** against inbound WhatsApp messages under a **non-personal business identity**.
Multi-tenant, directory-managed users, and one place to manage every agent.

> 🚧 **Status:** POC in progress. The repository currently contains the Phase 0 scaffolding
> (deploy overlay, config, AgentSpec schema, docs). See the roadmap below.

## How it's built

Whaser is built **on top of [LibreChat](https://github.com/danny-avila/LibreChat)** (MIT,
pinned to **v0.8.6** as a submodule), which provides LDAP/OIDC auth + multi-user RBAC, a
Claude + MCP agent runtime, and the chat/agent UI. Whaser adds, in separate modules:

- a **WhatsApp Cloud API** gateway (thin direct client: webhook in, Graph API out),
- the conversational **"Create new agent"** wizard,
- **multi-tenant** scoping + per-tenant cost budgets,
- the **agents dashboard** (status, bound number, activity).

| Concern | Choice |
| --- | --- |
| WhatsApp transport | Meta **Business Cloud API**, direct (non-personal business identity; webhook-based, headless-friendly) |
| Foundation | Fork of **LibreChat** v0.8.6 |
| AI core | **Anthropic Claude** — Sonnet 4.6 (interview + replies), Opus 4.8 (spec synthesis), Haiku 4.5 (classification) |
| Auth / tenancy | **lldap** directory (LDAP) + multi-tenant scoping |
| Deploy | Docker Compose on a headless Linux VM, Caddy TLS |

Full design in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md); the Claude/AI-feature
mapping (what Whaser uses, and when) is in [`docs/AI-FEATURES.md`](./docs/AI-FEATURES.md).

## Getting started

```bash
git clone https://github.com/ofirm7/whaser.git
cd whaser
git submodule update --init --recursive
cp deploy/.env.example deploy/.env   # then fill in (see docs/SETUP.md)
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

Full runbook (TLS/domain, Meta WhatsApp setup, lldap, verification) in
[`docs/SETUP.md`](./docs/SETUP.md).

## Roadmap

Phased POC build — details in [`docs/ROADMAP.md`](./docs/ROADMAP.md).

- [ ] **Phase 0** — Fork & deploy LibreChat (HTTPS + Claude)
- [ ] **Phase 1** — Directory auth (lldap + LibreChat LDAP)
- [ ] **Phase 2** — WhatsApp Cloud API gateway (echo bot, non-personal identity)
- [ ] **Phase 3** — Bridge WhatsApp ↔ LibreChat agent runtime
- [ ] **Phase 4** — Conversational create-agent wizard
- [ ] **Phase 5** — Agents dashboard + multi-tenant scoping
- [ ] **Phase 6** — Hardening, DR, observability, demo polish

## Repository layout

```
deploy/      docker-compose, Caddyfile, librechat.yaml, .env.example
docs/        ARCHITECTURE.md, ROADMAP.md, SETUP.md, AI-FEATURES.md, PHASE3-BRIDGE.md
schemas/     agent-spec.schema.json   (the AgentSpec the wizard emits)
librechat/   LibreChat v0.8.6 (git submodule; the fork base)
```

## License

MIT (intended; LICENSE file to follow). Built on LibreChat, which is MIT-licensed.
