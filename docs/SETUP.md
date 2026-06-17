# Whaser — Setup & Runbook

Operational guide for deploying Whaser on your headless Linux VM. Phases map to
[`ROADMAP.md`](./ROADMAP.md); architecture is in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

> Phase 0 and Phase 1 are runnable from the current repo. Phases 2+ describe what to do once
> the corresponding Whaser code lands (WhatsApp gateway, wizard, dashboard).

## Prerequisites

- A headless Linux VM you control (2 vCPU / 4 GB RAM is enough for a POC).
- **Docker** + the **Docker Compose** plugin installed.
- A **real public domain** with a DNS **A-record** pointing at the VM's public IP
  (e.g. `whaser.example.com`). Required for Let's Encrypt TLS — which the WhatsApp Cloud API
  webhook demands.
- Inbound **TCP 80 and 443** open in the VM firewall/security group.
- An **Anthropic API key**.

## Phase 0 — Stand up LibreChat (HTTPS + Claude)

```bash
# 1. Clone the repo and the pinned LibreChat fork (v0.8.6 submodule)
git clone https://github.com/ofirm7/whaser.git
cd whaser
git submodule update --init --recursive

# 2. Configure environment
cp deploy/.env.example deploy/.env
# Generate secrets and paste them into deploy/.env:
openssl rand -hex 32   # CREDS_KEY, JWT_SECRET, JWT_REFRESH_SECRET, MEILI_MASTER_KEY, LLDAP_*
openssl rand -hex 16   # CREDS_IV, WHASER_SENDER_HASH_SALT
# Set WHASER_DOMAIN / DOMAIN_CLIENT / DOMAIN_SERVER to your domain, and ANTHROPIC_API_KEY.

# 3. Bring up the stack
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
docker compose -f deploy/docker-compose.yml logs -f caddy api   # watch TLS issuance + boot
```

Then open `https://whaser.example.com`, register the **first** user (becomes admin), and
confirm you can chat with a Claude model (Opus 4.8 / Sonnet 4.6 / Haiku 4.5 appear in the
model picker).

**Done when:** you log in and chat with Claude over HTTPS at your domain.

> Note: After Phase 0, set `ALLOW_REGISTRATION=false` (accounts come from the directory).

## Phase 1 — Directory auth (lldap) — REQ 4

1. The `lldap` service is already in the compose file. Reach its admin UI via an SSH tunnel
   (it's bound to localhost on the VM):
   ```bash
   ssh -L 17170:127.0.0.1:17170 you@your-vm   # then open http://localhost:17170
   ```
   Log in as `admin` / `LLDAP_ADMIN_PASSWORD`.
2. Create two **groups** to act as tenants (e.g. `tenant-acme`, `tenant-globex`) and a few
   **users**; assign users to groups.
3. The LDAP env in `deploy/.env` already points LibreChat at lldap
   (`LDAP_URL=ldap://lldap:3890`, base DN `dc=whaser,dc=local`). Restart the API:
   ```bash
   docker compose -f deploy/docker-compose.yml up -d --force-recreate api
   ```
4. Log out and log back in as a **directory** user.

**Done when:** users authenticate via the directory and the admin manages users/groups in the
lldap UI. (Mapping groups → Whaser tenants/roles is finished in Phase 5.)

## Phase 2 — WhatsApp Cloud API (non-personal identity) — REQ 1

> Requires the Phase 2 code (`MessagingGateway` + webhook routes). Meta setup can be done in
> parallel since it's an external, approval-gated dependency.

**Meta setup (do this early — no SLA):**

1. Create a **Meta Business Portfolio** (business.facebook.com) — this is the non-personal
   identity. Do **not** use a personal Facebook identity as the business.
2. Create a **Meta App** (developers.facebook.com) → add the **WhatsApp** product.
3. Note the auto-provisioned **test number** and its **`phone_number_id`** (POC uses this; it
   is non-personal but **not** brand-verified). Add your own phone as a **verified recipient**
   (test numbers can only message pre-verified recipients, max 5).
4. Create a **System User** in Business Settings and mint a **long-lived access token** with
   `whatsapp_business_messaging` + `whatsapp_business_management`. **Use this token**, not the
   24-hour temporary one — the temp token silently breaks "always-on" the next day.
5. Set `WHATSAPP_*` in `deploy/.env` (`WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`,
   `WHATSAPP_PHONE_NUMBER_ID`, and a `WHATSAPP_VERIFY_TOKEN` you choose).
6. In the App's WhatsApp → Configuration, set the **Callback URL** to
   `https://whaser.example.com/api/whatsapp/webhook` and the **Verify Token** to your
   `WHATSAPP_VERIFY_TOKEN`, then subscribe to the `messages` field. Meta sends a `GET` to
   verify; the Whaser webhook answers the challenge.

**Done when:** messaging the test number from a pre-verified phone echoes back unattended over
HTTPS, still works the next day, and a duplicated Meta delivery does not double-reply.

### Verified brand identity (external dependency — track it)

A *verified* display name (real brand identity) requires Meta **Business Verification** +
**display-name review**: multi-week, approval-gated, and can be rejected. It is **not** a
config flip. Assign an owner and start it early; the POC runs on the test number until it
clears. Outbound/proactive messages also require **pre-approved templates** — out of scope for
the POC (the runtime stays inside the 24-hour customer service window).

## Phases 3–6

- **Phase 3** — bind a (hardcoded) agent to the number; inbound messages drive the LibreChat
  agent runtime and reply within the 24h window. Circuit-breaker + per-tenant budgets active.
- **Phase 4** — the conversational "Create new agent" wizard becomes available in the GUI.
- **Phase 5** — the Agents dashboard lists all agents with WhatsApp status; tenant scoping
  enforced.
- **Phase 6** — backups, retention, observability, demo polish (see below).

## Operations

```bash
# Logs / status
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs -f api

# Restart after config change
docker compose -f deploy/docker-compose.yml up -d --force-recreate api

# Encrypted off-box backup (Phase 6 — schedule nightly)
docker compose -f deploy/docker-compose.yml exec -T mongodb \
  mongodump --archive --db=LibreChat | gpg -c > "whaser-$(date +%F).archive.gpg"
#  ... then copy off-box, and DRILL the restore.

# Reboot-survival check (always-on): reboot the VM, confirm the stack comes back and replies.
sudo reboot
```

## Verification (end-to-end POC smoke test)

1. Log in via the **lldap directory**; a second user in another tenant **cannot** see your agents.
2. Run the **create-agent wizard** → guided Q&A → AgentSpec passes schema + consistency checks
   → **sandbox-chat** the draft → publish.
3. **Bind the test number**; message it from a pre-verified phone → in-character reply; context
   memory + a stubbed tool call work.
4. The new agent appears in the **Agents dashboard** with status/number/last-activity and token spend.
5. **Reboot the VM** → it still replies; a duplicated Meta delivery does **not** double-reply;
   the webhook rejects a bad HMAC.
6. Trip the **budget cap** → the circuit-breaker blocks further model calls.
