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

## HTTPS and a public address

Google sign-in needs Whaser on **https at a real domain**. The app can serve https itself next to the
plain-http port, in `apps/web/.env`:

```bash
HTTPS_PORT=9443
TLS_CERT_FILE=/etc/letsencrypt/live/whaser/fullchain.pem
TLS_KEY_FILE=/etc/letsencrypt/live/whaser/privkey.pem
PUBLIC_URL=https://whaser.example.com:9443
```

- The certificate is re-read every 12 hours, so Let's Encrypt renewals need no restart. If it can't be
  read, the error is logged and plain http keeps serving.
- With `PUBLIC_URL` set, a browser that opens Whaser anywhere else (the raw IP, plain http) is sent to it.
  API calls, webhooks and `localhost` (SSH tunnels) are never redirected.
- Get the certificate once the domain's DNS points at the server, e.g.
  `certbot certonly --webroot -w <the directory port 80 serves> -d whaser.example.com --cert-name whaser`
  (or `--standalone` when nothing listens on port 80). Certbot's timer renews it.

## Connect Google (Gmail, Calendar, Drive)

When you create an agent, the publish step lets you give it **Gmail**, **Google Calendar** and
**Google Drive** connections, each **Read only** or **Read & write** (also editable later from the
agent page → **🔗 Google connections**). The agent then gets real tools for what you ticked:

| Service | Read | Read & write adds |
|---|---|---|
| Gmail | search, read emails | send (incl. threaded replies), save drafts, mark read/unread, archive, star |
| Google Calendar | list events / check availability | create, update, delete events (attendees are notified) |
| Google Drive | search, read files (Docs, Sheets as CSV, Slides, text; folders list their files) | create Docs/Sheets/text files, replace a file's content, rename |

Connecting is a **"Sign in with Google"** button: the owner picks what the agent may do, clicks
**Sign in with Google**, and approves on Google's own consent screen in a pop-up — no setup, nothing to
create or paste. Each workspace links **one** Google account; every agent in the workspace can opt into it,
and asking for more access later just shows the button again (Google adds to what was already allowed).
**⚙️ Settings → Connected accounts** shows which account is signed in and what it allows, with
**Disconnect**. Tokens are stored owner-only in the gitignored `.data/google-accounts.json`. Writes are
simulated during the improve chat's test runs. The agent page warns when an agent's connections aren't
allowed by the signed-in account yet.

> ⚠️ Anyone who can message an agent can ask it to use its connections — with Gmail **Read & write**
> that includes sending email as you. Grant write access only to agents that need it.

### Turning on Sign in with Google (operator, once per Whaser server)

The Google app behind the button belongs to the Whaser deployment, not to its customers. Until it's set,
the button is replaced by "Sign in with Google isn't turned on for this Whaser server yet", and the server
log says `Sign in with Google: off`.

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create a project and
   enable the **Gmail API**, **Google Calendar API** and **Google Drive API**.
2. Configure the OAuth consent screen with Whaser's name, logo and support email — that's what customers
   see when they sign in. While it's in *Testing*, only the Google accounts added as test users can sign in.
3. Create an **OAuth client ID** of type *Web application* with the **Authorized redirect URI**
   `https://<your Whaser domain>/api/google/callback`. Google only accepts `https://` on a real domain, or
   `http://localhost:<port>` — never a raw IP address (on an IP, the button explains that Whaser must be
   opened at its secure address). See [HTTPS and a public address](#https-and-a-public-address).
4. Put the client in `apps/web/.env` and restart:

```bash
GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
# optional — otherwise derived from the URL the app is opened at (honours X-Forwarded-Proto/Host)
GOOGLE_REDIRECT_URI=https://whaser.example.com/api/google/callback
```

Switching to a different OAuth client later signs every workspace out of Google (their tokens belong to
the old client), so they'd each sign in again.

Scopes requested: `gmail.readonly` / `gmail.modify`, `calendar.events.readonly` / `calendar.events`,
`drive.readonly` / `drive` (read / read & write). The Gmail and Drive scopes are Google *restricted*
scopes (Calendar's are *sensitive*) — fine for test users, but opening sign-in to every customer needs
Google's app verification (for Gmail/Drive, including a security assessment). That's done once, by the
operator, for the whole Whaser deployment.

## Personal WhatsApp (QR link) — archived

Linking a personal WhatsApp account by QR code is **switched off**: agents answer only on the workspace's
WhatsApp business number (see below). The code is kept — set `WHASER_PERSONAL_WHATSAPP=on` in
`apps/web/.env` and restart to bring back the QR link and everything built on it: the chat picker,
groups by invite link, "answer my own messages", copying the owner's writing style, and timed actions
that message chats. While it's off, sessions saved in `.wa-auth/` stay on disk but never connect, and
`/api/wa/status` reports `disabled`.

## WhatsApp groups (invite links)

> Needs the personal WhatsApp link above, which is archived (off) by default.

An agent can be put into a WhatsApp group from the group's **invite link** (in WhatsApp: group info →
Invite via link). On the agent page click **👥 Join a group**, paste the link and **Preview** — Whaser shows
the group's name and size, and warns when an admin must approve new members or only admins may post (the
agent couldn't reply there). **Join and answer here** joins the group and the agent starts answering in it.
The same box is in the chat picker (create wizard and ✏️ Edit chats), where a joined group is ticked.

Groups are joined by the workspace's **QR-linked WhatsApp** account: WhatsApp business numbers (Twilio,
the Cloud API) can't join a group from an invite link. A spare number works best, since that account is
how the agent appears in the group.

Each chat under **Listening on** has a leave button: **🚪** on a group makes the linked WhatsApp actually
leave it (so no agent in the workspace answers there any more; coming back needs a new invite link), and
**✕** on a one-to-one chat just stops this agent answering it.

## WhatsApp business numbers (Twilio)

Instead of QR-linking a personal phone, a workspace can give its agents a real WhatsApp **business
number**, served through the operator's **Twilio** account — the Twilio Sandbox to try it, or registered
WhatsApp senders. Workspaces never see Twilio: in **⚙️ Settings → 📲 WhatsApp business number** they
click **Get a WhatsApp number** (they're given a free one from the operator's list), then open the agent
that should answer and click **📲 Answer on WhatsApp**. Everyone who messages the number talks to that
agent, through the same pipeline as every channel: cost/abuse breaker, billing gate, conversation memory,
tools, activity log. A paused agent stays silent. **Release number** hands it back for another workspace.

### Operator setup (once per server)

1. In the [Twilio Console](https://console.twilio.com/), copy the account's **Account SID** (`AC…`) and
   **Auth Token**.
2. Get a WhatsApp sender. To try it right away, use the Sandbox: open the **Try WhatsApp** page
   (Messaging → Try it out → Send a WhatsApp message) and note its number, **+1 415 523 8886**, and its
   join code (`join <two-words>`). For production, register your own WhatsApp senders in Twilio.
3. Put them in `apps/web/.env` and restart Whaser:

   ```bash
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_WHATSAPP_NUMBERS=+14155238886          # one or more, comma-separated — one per workspace
   TWILIO_SANDBOX_JOIN_CODE=join two-words       # optional (Sandbox): shown to workspaces with a one-tap link
   TWILIO_WEBHOOK_BASE_URL=https://whaser.example.com   # optional: only if a proxy hides the public address
   ```

   On startup the log confirms the account (`[twilio] account "…" (Trial, active)`) or says Twilio rejected
   the credentials, and prints the webhook URL to use.
4. In Twilio, set **"When a message comes in"** to `<public URL>/api/twilio/whatsapp`, method **POST** —
   for the Sandbox under Sandbox settings → Sandbox configuration; for your own senders on each sender (or
   its Messaging Service). One URL serves every number.

Twilio must be able to reach Whaser: a public IP or domain works (Twilio accepts `http://`, but `https://`
is recommended); `localhost` and private addresses don't.

Sandbox caveat: everyone who messages the Sandbox number has to send its join code to it first, and a
Sandbox session expires three days after joining. With `TWILIO_SANDBOX_JOIN_CODE` set, Settings shows the
code and an **Open WhatsApp to join** button (a `wa.me` link with the message typed in).

### How it works

- Every post is checked against **`X-Twilio-Signature`** (HMAC-SHA1 with the operator's Auth Token); a
  bad signature gets 403. Each message is routed to the workspace holding the number it was sent to.
- Twilio is answered immediately with empty TwiML; the agent's reply is sent afterwards through Twilio's
  REST API (agents can take longer than Twilio's 15-second webhook timeout). Replies over Twilio's
  1600-character limit go out as several messages. A re-posted webhook is not answered twice, and one
  customer's messages are answered in order.
- Images and PDFs a customer sends are passed to the agent (≤5MB); text files are inlined; voice notes and
  videos are acknowledged.
- Each reply carries a **status callback** (`/api/twilio/status`, no Twilio setup needed), so failed
  deliveries show up in the workspace's Settings and Activity feed with the reason — e.g. **63016**
  (outside WhatsApp's 24-hour window: a business can only send free-form messages within 24 hours of the
  customer's last message) or **63015** (the recipient hasn't joined the Sandbox).
- Which workspace holds which number (and its answering agent) is kept in the gitignored
  `.data/twilio-lines.json`. Removing a number from `TWILIO_WHATSAPP_NUMBERS` frees it.

Not covered yet: proactive messages outside the 24-hour window (WhatsApp requires pre-approved
templates), so scheduled triggers and the agent's own "send a message" tool keep using the QR-linked
channel.

## Going to full production (LibreChat fork)

The demo's direct Claude runtime is the `@anthropic-ai/sdk` fallback path. For the full system,
back the stores with MongoDB and swap the simulator's runtime for `LibreChatAgentClient` +
`CloudApiGateway` (real WhatsApp). See `docs/PHASE3-BRIDGE.md`, `docs/PHASE4-WIZARD.md`, `docs/SETUP.md`.
