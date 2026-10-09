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

## Connect Google (Gmail, Calendar, Drive)

When you create an agent, the publish step lets you give it **Gmail**, **Google Calendar** and
**Google Drive** connections, each **Read only** or **Read & write** (also editable later from the
agent page → **🔗 Google connections**). The agent then gets real tools for what you ticked:

| Service | Read | Read & write adds |
|---|---|---|
| Gmail | search, read emails | send (incl. threaded replies), save drafts, mark read/unread, archive, star |
| Google Calendar | list events / check availability | create, update, delete events (attendees are notified) |
| Google Drive | search, read files (Docs, Sheets as CSV, Slides, text; folders list their files) | create Docs/Sheets/text files, replace a file's content, rename |

Each workspace uses **its own Google OAuth client**, entered in the UI under **⚙️ Settings → Google**
(the connections picker opens the same form if it's missing), and links **one** Google account (OAuth
pop-up). Every agent in the workspace can opt into that account. The client secret is write-only (the
UI only ever shows its last 4 characters); on save, Whaser asks Google to confirm the ID + secret pair.
Client + tokens are stored owner-only in the gitignored `.data/google-clients.json` /
`.data/google-accounts.json`. Switching to a different client unlinks the account (its tokens belong
to the old client). Writes are simulated during the improve chat's test runs. The agent page warns when
an agent's connections aren't granted by the linked account yet.

> ⚠️ Anyone who can message an agent can ask it to use its connections — with Gmail **Read & write**
> that includes sending email as you. Grant write access only to agents that need it.

Creating the OAuth client (once per workspace — the Settings page walks through it):

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials) create a project, enable
   the **Gmail API**, **Google Calendar API** and **Google Drive API**, and configure the OAuth consent
   screen (while it's in *Testing*, add your Google accounts as test users).
2. Create an **OAuth client ID** of type *Web application* and add the **Authorized redirect URI** shown
   in Settings (`<the URL you opened Whaser at>/api/google/callback`). Google only accepts `https://` on a
   real domain, or `http://localhost:<port>` (e.g. through an SSH tunnel) — never a raw IP address; the
   Settings page warns when the current address won't work.
3. Paste the client ID and secret into Settings → Google and save.

Optional server-wide default (used by workspaces that haven't saved their own), in `apps/web/.env`:

```bash
GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
# optional — otherwise derived from the URL the app is opened at (honours X-Forwarded-Proto/Host)
GOOGLE_REDIRECT_URI=https://whaser.example.com/api/google/callback
```

Scopes requested: `gmail.readonly` / `gmail.modify`, `calendar.events.readonly` / `calendar.events`,
`drive.readonly` / `drive` (read / read & write). The Gmail and Drive scopes are Google *restricted*
scopes (Calendar's are *sensitive*) — fine for test users, but a public app needs Google's verification.

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
