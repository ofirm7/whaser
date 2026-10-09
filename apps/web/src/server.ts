import './env';
import express, { type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { authenticate, registerUser, tenantName } from './directory';
import { AppState } from './store';
import { callbackPage, redirectUriProblem, suggestConnections, normalizeConnections, type AgentConnections } from './google';
import type { TuningSuggestion } from '../../../packages/agent-builder/src/index';
import { createWebhookRouter } from '../../../packages/whatsapp-gateway/src/express';
import { parseTwilioInbound, parseTwilioStatus, verifyTwilioSignature } from '../../../packages/whatsapp-gateway/src/twilio';
import type { TwilioParams } from '../../../packages/whatsapp-gateway/src/twilio';
import { TWILIO_WEBHOOK_PATH, TWILIO_STATUS_PATH } from './twilio';

interface SessionUser {
  username: string;
  displayName: string;
  tenantId: string;
  tenantName: string;
  role: 'admin' | 'user';
}

const state = new AppState();
const tokens = new Map<string, SessionUser>();

function getAuth(req: Request): SessionUser | null {
  const m = (req.header('authorization') ?? '').match(/^Bearer (.+)$/);
  return m ? tokens.get(m[1]) ?? null : null;
}

const wrap =
  (fn: (req: Request, res: Response, auth: SessionUser) => Promise<void>) =>
  (req: Request, res: Response): void => {
    const auth = getAuth(req);
    if (!auth) {
      res.sendStatus(401);
      return;
    }
    fn(req, res, auth).catch((err: unknown) => {
      // Log it: an API failure that only ever reached the browser leaves no trace of why, say, a
      // freshly designed agent never got published.
      console.error(`[api] ${req.method} ${req.path} (${auth.username}/${auth.tenantId}):`, err);
      if (!res.headersSent) res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    });
  };

const agentSummary = (a: ReturnType<AppState['listAgents']>[number]) => ({
  id: a.id,
  name: a.spec.agent_name,
  version: a.spec.version,
  status: a.status,
  phoneNumberId: a.phoneNumberId,
  tone: a.spec.brand_persona.tone,
  goal: a.spec.goal,
  model: a.spec.model_assignment,
  createdAt: a.createdAt,
  lastActivityAt: a.lastActivityAt,
  twilioNumber: state.twilioNumberOf(a),
});

const catalogSummary = (e: ReturnType<AppState['listCatalog']>[number]) => ({
  id: e.id,
  title: e.title,
  description: e.description,
  category: e.category,
  icon: e.icon ?? null,
  name: e.spec.agent_name,
  tone: e.spec.brand_persona.tone,
  model: e.spec.model_assignment,
  goal: e.spec.goal,
});

/** The scheme + host the app is being used at (honours X-Forwarded-Proto/Host from a proxy). */
function requestBase(req: Request): string {
  const proto = String(req.header('x-forwarded-proto') ?? req.protocol).split(',')[0].trim();
  const host = String(req.header('x-forwarded-host') ?? req.get('host') ?? '').split(',')[0].trim();
  return `${proto}://${host}`;
}

/** Where Google sends the sign-in pop-up back to — must be registered on the deployment's Google OAuth
 *  client. GOOGLE_REDIRECT_URI pins it; otherwise it follows the URL the app is being used at. */
function googleRedirectUri(req: Request): string {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  return `${requestBase(req)}/api/google/callback`;
}

/** The public base URL Twilio calls Whaser at: TWILIO_WEBHOOK_BASE_URL when pinned, else the request's. */
function publicBase(req: Request): string {
  return process.env.TWILIO_WEBHOOK_BASE_URL?.replace(/\/+$/, '') || requestBase(req);
}

const GOOGLE_NONCE_COOKIE = 'whaser_google_nonce';

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.header('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const app = express();

// Real WhatsApp Cloud API webhook — mounted FIRST so its raw-body parser (needed for the
// X-Hub-Signature-256 HMAC) runs before the global JSON parser. Only when configured.
const webhookDeps = state.webhookDeps();
if (webhookDeps) {
  app.use('/api/whatsapp/webhook', createWebhookRouter(webhookDeps));
  console.log('WhatsApp webhook mounted at /api/whatsapp/webhook');
}

// Twilio WhatsApp webhooks — form-encoded and signed (X-Twilio-Signature) with the operator's Auth
// Token, one URL for all of the operator's numbers; each message is routed to the workspace holding the
// number it was sent to. An inbound message is acknowledged at once with empty TwiML and answered in the
// background through the REST API, since an agent's reply can outlast Twilio's 15-second webhook timeout.
const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const twilioForm = express.urlencoded({ extended: false, limit: '256kb' });

/** The params + public base of a genuine Twilio webhook, or null after answering 404/403. */
function twilioWebhook(req: Request, res: Response): { params: TwilioParams; base: string } | null {
  const platform = state.twilio.platform;
  if (!platform) {
    res.sendStatus(404);
    return null;
  }
  const params = (req.body ?? {}) as TwilioParams;
  const base = publicBase(req);
  // The signature covers the exact URL configured in Twilio; try it as seen through a proxy and directly.
  const urls = [base + req.originalUrl, `${req.protocol}://${req.get('host')}${req.originalUrl}`];
  if (!verifyTwilioSignature(platform.authToken, req.header('x-twilio-signature'), urls, params)) {
    console.warn(`[twilio] rejected a webhook whose signature didn't match (checked ${[...new Set(urls)].join(' , ')}) — the URL in Twilio must be exactly ${base}${TWILIO_WEBHOOK_PATH} and TWILIO_AUTH_TOKEN the account's current token`);
    res.sendStatus(403);
    return null;
  }
  return { params, base };
}

app.post(TWILIO_WEBHOOK_PATH, twilioForm, (req: Request, res: Response) => {
  const hook = twilioWebhook(req, res);
  if (!hook) return;
  res.type('text/xml').send(TWIML_EMPTY);
  const inbound = parseTwilioInbound(hook.params); // null for an SMS or anything else that isn't WhatsApp
  if (!inbound) return;
  const tenantId = state.twilio.tenantOf(inbound.to);
  if (!tenantId) {
    console.warn(`[twilio] a WhatsApp message to ${inbound.to} arrived, but no workspace has that number yet`);
    return;
  }
  void state.handleTwilioInbound(tenantId, inbound, hook.base);
});

app.post(TWILIO_STATUS_PATH, twilioForm, (req: Request, res: Response) => {
  const hook = twilioWebhook(req, res);
  if (!hook) return;
  res.sendStatus(204);
  const status = parseTwilioStatus(hook.params);
  const tenantId = status?.from ? state.twilio.tenantOf(status.from) : null;
  if (status && tenantId) state.handleTwilioStatus(tenantId, status);
});

app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true, app: 'whaser-web', mode: state.mode }));

// Coarse in-memory rate limiter for the auth endpoints (brute-force / spam guard).
const authAttempts = new Map<string, { n: number; t: number }>();
function rateLimited(key: string, max = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  const e = authAttempts.get(key);
  if (!e || now - e.t > windowMs) {
    authAttempts.set(key, { n: 1, t: now });
    return false;
  }
  e.n += 1;
  return e.n > max;
}

app.post('/api/login', async (req: Request, res: Response) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
  if (rateLimited('login:' + String(username ?? '').toLowerCase())) {
    res.status(429).json({ error: 'too many attempts — wait a minute' });
    return;
  }
  const u = await authenticate(String(username ?? ''), String(password ?? ''));
  if (!u) {
    res.status(401).json({ error: 'invalid credentials' });
    return;
  }
  const token = randomBytes(24).toString('hex');
  const user: SessionUser = {
    username: u.username,
    displayName: u.displayName,
    tenantId: u.tenantId,
    tenantName: tenantName(u.tenantId),
    role: u.role,
  };
  tokens.set(token, user);
  res.json({ token, user, mode: state.mode, whatsapp: state.whatsappStatus(), billing: state.billingState(user.tenantId) });
});

app.post('/api/register', async (req: Request, res: Response) => {
  if (rateLimited('register:' + (req.ip ?? ''), 5)) {
    res.status(429).json({ error: 'too many sign-ups — wait a minute' });
    return;
  }
  const { username, password, displayName } = (req.body ?? {}) as { username?: string; password?: string; displayName?: string };
  let u;
  try {
    u = await registerUser(String(username ?? ''), String(password ?? ''), String(displayName ?? ''));
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'registration failed' });
    return;
  }
  const token = randomBytes(24).toString('hex');
  const user: SessionUser = { username: u.username, displayName: u.displayName, tenantId: u.tenantId, tenantName: u.tenantName, role: u.role };
  tokens.set(token, user);
  res.json({ token, user, mode: state.mode, whatsapp: state.whatsappStatus(), billing: state.billingState(user.tenantId) });
});

app.get('/api/me', (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth) {
    res.sendStatus(401);
    return;
  }
  res.json({ user: auth, mode: state.mode, whatsapp: state.whatsappStatus(), tenantTokensUsed: state.tenantUsage(auth.tenantId), billing: state.billingState(auth.tenantId) });
});

// --- Billing (per-tenant USD balance; AI stops at $0, resumes above $1) ---
app.get('/api/billing', wrap(async (_req, res, auth) => {
  res.json({ ...state.billingState(auth.tenantId), usage: state.usageBreakdown(auth.tenantId) });
}));
app.post('/api/billing/topup', wrap(async (req, res, auth) => {
  const { amount } = (req.body ?? {}) as { amount?: unknown };
  res.json(state.topUp(auth.tenantId, Number(amount) || 0));
}));

// --- Wizard ---
app.post('/api/wizard/start', wrap(async (_req, res, auth) => {
  const session = state.startSession(auth.username, auth.tenantId);
  const { greeting } = state.builder.startInterview();
  res.json({ sessionId: session.id, greeting });
}));

// One turn of the free-form agent-design chat: append the user's message, get the interviewer's
// next reply, and whether enough is known to build the agent.
app.post('/api/wizard/message', wrap(async (req, res, auth) => {
  const { sessionId, text } = (req.body ?? {}) as { sessionId?: string; text?: string };
  const session = state.getSession(String(sessionId));
  if (!session || session.ownerUsername !== auth.username) {
    res.sendStatus(404);
    return;
  }
  const userText = String(text ?? '').trim();
  if (!userText) {
    res.status(400).json({ error: 'empty message' });
    return;
  }
  if (!state.canSpend(auth.tenantId)) {
    res.status(402).json({ error: 'Your balance is empty — add credit (above $1) to keep chatting with Whaser.' });
    return;
  }
  session.messages.push({ role: 'user', content: userText });
  const { reply, readyToBuild, buildNow } = await state.builder.interview(session.messages);
  state.recordSpendText(auth.tenantId, userText, reply);
  session.messages.push({ role: 'assistant', content: reply });
  res.json({ reply, readyToBuild, buildNow });
}));

app.post('/api/wizard/select-chats', wrap(async (req, res, auth) => {
  const { sessionId, chats } = (req.body ?? {}) as { sessionId?: string; chats?: Array<{ id?: unknown; name?: unknown }> };
  const session = state.getSession(String(sessionId));
  if (!session || session.ownerUsername !== auth.username) {
    res.sendStatus(404);
    return;
  }
  const list = (Array.isArray(chats) ? chats : [])
    .filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string')
    .map((c) => ({ id: String(c.id), name: String(c.name) }));
  // An EMPTY selection is legitimate and must stay that way: a brand-new user has no WhatsApp link
  // yet, so there are no chats to pick — and gating this on a non-empty list is exactly what made a
  // freshly designed agent impossible to publish (it only ever existed in the wizard session, so it
  // "vanished" the moment the page was left). Chats are bound later via POST /api/agents/:id/chats,
  // which has always accepted an empty list.
  session.selectedChats = list;
  res.json({ selected: list.length, listenChats: list });
}));

app.post('/api/wizard/finalize', wrap(async (req, res, auth) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: string };
  const session = state.getSession(String(sessionId));
  if (!session || session.ownerUsername !== auth.username) {
    res.sendStatus(404);
    return;
  }
  const r = await state.builder.finalizeInterview(session.messages);
  session.finalizeResult = r;
  // Pre-tick the Google connections the conversation asked for (the owner confirms in the publish step).
  res.json({ ...r, suggestedConnections: suggestConnections(session.messages) });
}));

app.post('/api/wizard/publish', wrap(async (req, res, auth) => {
  const { sessionId, connections } = (req.body ?? {}) as { sessionId?: string; connections?: unknown };
  const session = state.getSession(String(sessionId));
  if (!session || session.ownerUsername !== auth.username) {
    res.sendStatus(404);
    return;
  }
  const agent = state.publish(session, connections);
  state.bindChatsToAgent(agent.id, session.tenantId, session.selectedChats ?? []);
  // Behind the scenes: if the design conversation asked for the owner's own style/voice, learn it
  // from their WhatsApp writing and tune the new agent to match (best-effort; never blocks publish).
  const ownerStyled = await state.applyOwnerStyleIfRequested(agent.id, session.tenantId, session.messages);
  res.json({ agentId: agent.id, phoneNumberId: agent.phoneNumberId, listenChats: agent.listenChats, status: agent.status, ownerStyled, connections: agent.connections ?? {} });
}));

// --- Agents (tenant-scoped) ---
app.get('/api/agents', wrap(async (_req, res, auth) => {
  res.json({ agents: state.listAgents(auth.tenantId).map(agentSummary) });
}));

app.get('/api/agents/:id', wrap(async (req, res, auth) => {
  const a = state.getAgent(req.params.id, auth.tenantId);
  if (!a) {
    res.sendStatus(404);
    return;
  }
  res.json({ ...agentSummary(a), spec: a.spec, ownerUsername: a.ownerUsername, listenChats: a.listenChats, triggers: a.triggers ?? [], answerSelf: a.answerSelf === true, connections: a.connections ?? {}, twilio: state.twilioLine(auth.tenantId, a.id) });
}));

app.delete('/api/agents/:id', wrap(async (req, res, auth) => {
  if (!(await state.deleteAgent(req.params.id, auth.tenantId))) {
    res.sendStatus(404);
    return;
  }
  res.json({ ok: true });
}));

// --- Catalog (global, curated; deploy-as-is into the caller's tenant) ---
app.get('/api/catalog', wrap(async (_req, res) => {
  res.json({ catalog: state.listCatalog().map(catalogSummary) });
}));

app.get('/api/catalog/:id', wrap(async (req, res) => {
  const e = state.getCatalogEntry(req.params.id);
  if (!e) {
    res.sendStatus(404);
    return;
  }
  res.json({ ...catalogSummary(e), spec: e.spec });
}));

app.post('/api/catalog/:id/deploy', wrap(async (req, res, auth) => {
  if (!state.getCatalogEntry(req.params.id)) {
    res.sendStatus(404);
    return;
  }
  const a = state.deployFromCatalog(req.params.id, auth.username, auth.tenantId);
  res.json({ agentId: a.id, phoneNumberId: a.phoneNumberId, status: a.status });
}));

app.get('/api/whatsapp/status', wrap(async (_req, res) => {
  res.json(state.whatsappStatus());
}));

app.post('/api/agents/:id/connect-whatsapp', wrap(async (req, res, auth) => {
  const a = state.bindRealNumber(req.params.id, auth.tenantId);
  res.json({ id: a.id, phoneNumberId: a.phoneNumberId, boundAgentId: a.id });
}));

// --- Sign in with Google: one Google account per workspace behind agents' Gmail / Calendar / Drive ---
/** The access the workspace's agents use between them — what "Sign in with Google" in Settings asks for. */
function agentsGoogleUse(tenantId: string): AgentConnections {
  const use: AgentConnections = {};
  for (const a of state.listAgents(tenantId)) {
    for (const [s, acc] of Object.entries(normalizeConnections(a.connections)) as Array<[keyof AgentConnections, 'read' | 'read_write']>) {
      if (use[s] !== 'read_write') use[s] = acc;
    }
  }
  return use;
}

app.get('/api/google/status', wrap(async (_req, res, auth) => {
  res.json({ ...state.google.status(auth.tenantId), agentsUse: agentsGoogleUse(auth.tenantId) });
}));

// Start "Sign in with Google": returns Google's consent URL for the pop-up. A nonce cookie ties the callback to this
// browser, so a sign-in link started by someone else can't attach a Google account to their workspace.
app.post('/api/google/connect', wrap(async (req, res, auth) => {
  const { services } = (req.body ?? {}) as { services?: unknown };
  const redirectUri = googleRedirectUri(req);
  // Google only sends people back to https (or localhost) — say so here instead of in a Google error page.
  if (state.google.isConfigured() && redirectUriProblem(redirectUri)) {
    throw new Error("Sign in with Google only works when Whaser is opened at its secure web address (https://…). Please open Whaser there and try again.");
  }
  const { url, nonce } = state.google.beginAuth({ tenantId: auth.tenantId, username: auth.username, services, redirectUri });
  const secure = redirectUri.startsWith('https:');
  res.cookie(GOOGLE_NONCE_COOKIE, nonce, { httpOnly: true, sameSite: 'lax', secure, maxAge: 10 * 60_000, path: '/api/google/callback' });
  res.json({ url });
}));

// The OAuth redirect target (a browser navigation, so no bearer token — the one-time state + nonce
// cookie identify the workspace). Renders a small page that tells the opener and closes itself.
app.get('/api/google/callback', async (req: Request, res: Response) => {
  const { code, state: oauthState, error } = req.query as Record<string, string | undefined>;
  let ok = false;
  let message: string;
  if (error) {
    state.google.cancelAuth(String(oauthState ?? ''));
    message = error === 'access_denied' ? 'Google access was not granted.' : `Google sign-in failed (${error}).`;
  } else {
    try {
      await state.google.completeAuth({ state: String(oauthState ?? ''), code: String(code ?? ''), nonce: readCookie(req, GOOGLE_NONCE_COOKIE) });
      ok = true;
      message = 'Google account connected.';
    } catch (e) {
      message = e instanceof Error ? e.message : 'Google sign-in failed.';
    }
  }
  res.clearCookie(GOOGLE_NONCE_COOKIE, { path: '/api/google/callback' });
  res.set('Cache-Control', 'no-store').type('html').send(callbackPage(ok, message));
});

app.post('/api/google/disconnect', wrap(async (_req, res, auth) => {
  await state.google.disconnect(auth.tenantId);
  res.json(state.google.status(auth.tenantId));
}));

// --- Settings: the workspace's WhatsApp business number, given out from the operator's Twilio account ---
const twilioSettings = (tenantId: string) => {
  const s = state.twilio.settings(tenantId);
  const agent = s.agentId ? state.getAgent(s.agentId, tenantId) : undefined;
  return { ...s, agentId: agent?.id ?? null, agentName: agent?.spec.agent_name ?? null };
};

app.get('/api/settings/twilio', wrap(async (_req, res, auth) => {
  res.json(twilioSettings(auth.tenantId));
}));

app.post('/api/settings/twilio/claim', wrap(async (_req, res, auth) => {
  state.twilio.claim(auth.tenantId, auth.username);
  res.json(twilioSettings(auth.tenantId));
}));

app.delete('/api/settings/twilio', wrap(async (_req, res, auth) => {
  state.releaseTwilio(auth.tenantId);
  res.json(twilioSettings(auth.tenantId));
}));

// --- QR-linked personal WhatsApp (POC) — each user links their OWN account (tenant-scoped) ---
app.post('/api/wa/link', wrap(async (_req, res, auth) => {
  await state.startPersonalLink(auth.tenantId);
  res.json(state.personalLinkStatus(auth.tenantId));
}));

app.get('/api/wa/status', wrap(async (_req, res, auth) => {
  res.json(state.personalLinkStatus(auth.tenantId));
}));

app.get('/api/wa/chats', wrap(async (req, res, auth) => {
  res.json({ chats: state.listPersonalChats(auth.tenantId, String(req.query.q ?? '')) });
}));

app.get('/api/wa/photo', wrap(async (req, res, auth) => {
  const jid = String(req.query.jid ?? '');
  if (!jid) {
    res.status(400).json({ url: null });
    return;
  }
  const url = await state.personalChatPhoto(auth.tenantId, jid);
  res.set('Cache-Control', 'private, max-age=300'); // mirror the server-side TTL
  res.json({ url });
}));

app.post('/api/agents/:id/suggest', wrap(async (req, res, auth) => {
  const { instruction } = (req.body ?? {}) as { instruction?: string };
  const r = await state.suggestImprovements(req.params.id, auth.tenantId, instruction);
  if (!r) {
    res.sendStatus(404);
    return;
  }
  res.json(r);
}));

// --- Conversational "improve this agent" chat (agent paused while improving) ---
app.post('/api/agents/:id/improve/start', wrap(async (req, res, auth) => {
  const r = state.startImprove(req.params.id, auth.tenantId, auth.username);
  if (!r) { res.sendStatus(404); return; }
  res.json(r);
}));
app.post('/api/agents/:id/improve/message', wrap(async (req, res, auth) => {
  const { sessionId, text } = (req.body ?? {}) as { sessionId?: string; text?: string };
  const t = String(text ?? '').trim();
  if (!t) { res.status(400).json({ error: 'empty message' }); return; }
  const r = await state.improveMessage(String(sessionId), auth.username, t);
  if (!r) { res.sendStatus(404); return; }
  res.json(r);
}));
app.post('/api/agents/:id/improve/apply', wrap(async (req, res, auth) => {
  const { extension } = (req.body ?? {}) as { extension?: unknown };
  const a = state.applyExtension(req.params.id, auth.tenantId, extension as never);
  res.json({ id: a.id, version: a.spec.version });
}));
app.post('/api/agents/:id/improve/finish', wrap(async (req, res, auth) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: string };
  const r = state.finishImprove(String(sessionId), auth.username);
  if (!r) { res.sendStatus(404); return; }
  res.json(r);
}));

app.post('/api/agents/:id/apply', wrap(async (req, res, auth) => {
  const { suggestions } = (req.body ?? {}) as { suggestions?: TuningSuggestion[] };
  const a = state.applyImprovements(req.params.id, auth.tenantId, Array.isArray(suggestions) ? suggestions : []);
  res.json({ id: a.id, version: a.spec.version });
}));

// Edit an existing agent's chat allow-list.
app.post('/api/agents/:id/chats', wrap(async (req, res, auth) => {
  const { chats } = (req.body ?? {}) as { chats?: Array<{ id?: unknown; name?: unknown }> };
  const list = (Array.isArray(chats) ? chats : [])
    .filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string')
    .map((c) => ({ id: String(c.id), name: String(c.name) }));
  const a = state.editChats(req.params.id, auth.tenantId, list);
  res.json({ id: a.id, listenChats: a.listenChats });
}));

// Which Google services (Gmail / Calendar / Drive) the agent may use, each 'read' or 'read_write'.
app.post('/api/agents/:id/connections', wrap(async (req, res, auth) => {
  const { connections } = (req.body ?? {}) as { connections?: unknown };
  const a = state.setConnections(req.params.id, auth.tenantId, connections);
  if (!a) { res.sendStatus(404); return; }
  res.json({ id: a.id, connections: a.connections ?? {} });
}));

// Make this agent the one answering the workspace's WhatsApp business number (or stop it answering).
app.post('/api/agents/:id/twilio', wrap(async (req, res, auth) => {
  const { enabled } = (req.body ?? {}) as { enabled?: unknown };
  const a = state.setTwilioAgent(req.params.id, auth.tenantId, enabled === true);
  res.json(state.twilioLine(auth.tenantId, a.id));
}));

app.post('/api/agents/:id/answer-self', wrap(async (req, res, auth) => {
  const { enabled } = (req.body ?? {}) as { enabled?: unknown };
  const a = state.setAnswerSelf(req.params.id, auth.tenantId, enabled === true);
  if (!a) { res.sendStatus(404); return; }
  res.json({ id: a.id, answerSelf: a.answerSelf === true });
}));

// --- Scheduled triggers (auto-firing timed actions) ---
app.post('/api/agents/:id/triggers', wrap(async (req, res, auth) => {
  if (!state.getAgent(req.params.id, auth.tenantId)) {
    res.sendStatus(404);
    return;
  }
  const { label, prompt, value, unit, enabled, toolName } = (req.body ?? {}) as Record<string, unknown>;
  const trigger = state.addTrigger(req.params.id, auth.tenantId, { label, prompt, value, unit, enabled, toolName });
  res.json({ trigger });
}));

app.patch('/api/agents/:id/triggers/:trgId', wrap(async (req, res, auth) => {
  if (!state.getAgent(req.params.id, auth.tenantId)) {
    res.sendStatus(404);
    return;
  }
  const trigger = state.updateTrigger(req.params.id, auth.tenantId, req.params.trgId, (req.body ?? {}) as Record<string, unknown>);
  res.json({ trigger });
}));

app.delete('/api/agents/:id/triggers/:trgId', wrap(async (req, res, auth) => {
  if (!state.getAgent(req.params.id, auth.tenantId)) {
    res.sendStatus(404);
    return;
  }
  if (!state.deleteTrigger(req.params.id, auth.tenantId, req.params.trgId)) {
    res.sendStatus(404);
    return;
  }
  res.json({ ok: true });
}));

// Manually fire a trigger now ("Run now" — an explicit test, sends real messages if linked).
app.post('/api/agents/:id/triggers/:trgId/run', wrap(async (req, res, auth) => {
  if (!state.getAgent(req.params.id, auth.tenantId)) {
    res.sendStatus(404);
    return;
  }
  const trigger = await state.runTriggerNow(req.params.id, auth.tenantId, req.params.trgId);
  res.json({ trigger, fired: true });
}));

// AI "Add timed action" builder — a conversational flow that auto-builds capabilities, then a trigger.
app.post('/api/agents/:id/triggers/start', wrap(async (_req, res, auth) => {
  const r = state.startTriggerBuilder(_req.params.id, auth.tenantId, auth.username);
  if (!r) {
    res.sendStatus(404);
    return;
  }
  res.json(r);
}));

app.post('/api/agents/:id/triggers/message', wrap(async (req, res, auth) => {
  const { sessionId, text } = (req.body ?? {}) as { sessionId?: string; text?: string };
  const userText = String(text ?? '').trim();
  if (!userText) {
    res.status(400).json({ error: 'empty message' });
    return;
  }
  const r = await state.triggerBuilderMessage(String(sessionId), auth.username, userText);
  if (!r) {
    res.sendStatus(404);
    return;
  }
  res.json(r);
}));

app.post('/api/agents/:id/triggers/propose', wrap(async (req, res, auth) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: string };
  const plan = await state.proposeTriggerPlan(String(sessionId), auth.username);
  if (!plan) {
    res.sendStatus(404);
    return;
  }
  res.json({ plan });
}));

app.post('/api/agents/:id/triggers/apply', wrap(async (req, res, auth) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: string };
  const r = state.applyTriggerPlan(String(sessionId), auth.username);
  if (!r) {
    res.sendStatus(404);
    return;
  }
  res.json(r);
}));

// --- Extend an existing agent: Context / Skills / Workflows ---
app.post('/api/agents/:id/extend/propose', wrap(async (req, res, auth) => {
  const { kind, instruction, prior } = (req.body ?? {}) as { kind?: string; instruction?: string; prior?: unknown };
  if (kind !== 'context' && kind !== 'skill' && kind !== 'workflow') {
    res.status(400).json({ error: 'kind must be context|skill|workflow' });
    return;
  }
  const ext = await state.proposeExtension(req.params.id, auth.tenantId, kind, String(instruction ?? ''), (prior ?? null) as never);
  if (!ext) {
    res.sendStatus(404);
    return;
  }
  res.json({ extension: ext });
}));

app.post('/api/agents/:id/extend/context-file', wrap(async (req, res, auth) => {
  const { label, text } = (req.body ?? {}) as { label?: string; text?: string };
  if (!state.getAgent(req.params.id, auth.tenantId)) {
    res.sendStatus(404);
    return;
  }
  if (!String(text ?? '').trim()) {
    res.status(400).json({ error: 'empty file text' });
    return;
  }
  res.json({ extension: state.contextFromText(String(label ?? 'file'), String(text)) });
}));

app.post('/api/agents/:id/extend/context-url', wrap(async (req, res, auth) => {
  const { url } = (req.body ?? {}) as { url?: string };
  if (!state.getAgent(req.params.id, auth.tenantId)) {
    res.sendStatus(404);
    return;
  }
  if (!/^https?:\/\//i.test(String(url ?? ''))) {
    res.status(400).json({ error: 'url must start with http(s)://' });
    return;
  }
  res.json({ extension: await state.contextFromUrl(String(url)) });
}));

app.post('/api/agents/:id/extend/apply', wrap(async (req, res, auth) => {
  const { extension } = (req.body ?? {}) as { extension?: unknown };
  if (!extension || typeof extension !== 'object') {
    res.status(400).json({ error: 'missing extension' });
    return;
  }
  const a = state.applyExtension(req.params.id, auth.tenantId, extension as never);
  res.json({ id: a.id, version: a.spec.version });
}));

app.post('/api/agents/:id/:action', wrap(async (req, res, auth) => {
  const action = req.params.action;
  if (action !== 'pause' && action !== 'resume') {
    res.status(400).json({ error: 'unknown action' });
    return;
  }
  const a = state.setStatus(req.params.id, auth.tenantId, action === 'pause' ? 'paused' : 'live');
  if (!a) {
    res.sendStatus(404);
    return;
  }
  res.json({ id: a.id, status: a.status });
}));

// --- WhatsApp simulator ---
app.post('/api/sim/send', wrap(async (req, res, auth) => {
  const { agentId, from, text } = (req.body ?? {}) as { agentId?: string; from?: string; text?: string };
  const out = await state.simulateInbound(String(agentId), auth.tenantId, String(from || 'sim-user'), String(text ?? ''));
  if (!out) {
    res.sendStatus(404);
    return;
  }
  res.json(out);
}));

app.get('/api/sim/history', wrap(async (req, res, auth) => {
  const agentId = String(req.query.agentId ?? '');
  const from = String(req.query.from ?? 'sim-user');
  res.json({ history: await state.history(agentId, auth.tenantId, from) });
}));

// --- Live activity log (inbound → routed → reply), tenant-scoped ---
app.get('/api/activity', wrap(async (req, res, auth) => {
  const agentId = req.query.agentId ? String(req.query.agentId) : undefined;
  res.json({ events: state.recentActivity(auth.tenantId, agentId) });
}));

// --- Static SPA ---
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
// no-cache on the SPA so a redeploy/restart always serves the latest JS (avoids stale clients).
app.use(express.static(publicDir, { etag: false, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
app.get('*', (_req: Request, res: Response) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(`${publicDir}/index.html`);
});

const port = Number(process.env.PORT ?? 8080);
app.listen(port, '0.0.0.0', () => {
  console.log(`Whaser demo GUI on http://0.0.0.0:${port}  (login: alice/password, bob/password, carol/password)`);
  const pinned = process.env.GOOGLE_REDIRECT_URI;
  if (!state.google.isConfigured()) console.log('Sign in with Google: off — set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (see apps/web/README.md) to turn it on for every workspace');
  else console.log(`Sign in with Google: on (redirect URI ${pinned ?? '<the URL Whaser is opened at>/api/google/callback'}${pinned && redirectUriProblem(pinned) ? ' — ⚠ Google rejects this address: use https on a domain, or localhost' : ''})`);
  if (state.twilio.platform) {
    const base = process.env.TWILIO_WEBHOOK_BASE_URL?.replace(/\/+$/, '') || `http://<this server's public address>:${port}`;
    console.log(`[twilio] in Twilio, set "When a message comes in" (POST) for ${state.twilio.platform.numbers.join(', ')} to ${base}${TWILIO_WEBHOOK_PATH}`);
  }
});
