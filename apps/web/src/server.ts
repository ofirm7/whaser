import './env';
import express, { type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { authenticate, registerUser, tenantName } from './directory';
import { AppState } from './store';
import type { TuningSuggestion } from '../../../packages/agent-builder/src/index';
import { createWebhookRouter } from '../../../packages/whatsapp-gateway/src/express';

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
      if (!res.headersSent) res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    });
  };

const uiPrompt = (p: { kind: 'ask'; slot: { id: string; question: string } } | { kind: 'confirm'; text: string }) =>
  p.kind === 'ask' ? { kind: 'ask', slotId: p.slot.id, question: p.slot.question } : { kind: 'confirm', text: p.text };

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

const app = express();

// Real WhatsApp Cloud API webhook — mounted FIRST so its raw-body parser (needed for the
// X-Hub-Signature-256 HMAC) runs before the global JSON parser. Only when configured.
const webhookDeps = state.webhookDeps();
if (webhookDeps) {
  app.use('/api/whatsapp/webhook', createWebhookRouter(webhookDeps));
  console.log('WhatsApp webhook mounted at /api/whatsapp/webhook');
}

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
  res.json({ token, user, mode: state.mode, whatsapp: state.whatsappStatus() });
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
  res.json({ token, user, mode: state.mode, whatsapp: state.whatsappStatus() });
});

app.get('/api/me', (req: Request, res: Response) => {
  const auth = getAuth(req);
  if (!auth) {
    res.sendStatus(401);
    return;
  }
  res.json({ user: auth, mode: state.mode, whatsapp: state.whatsappStatus(), tenantTokensUsed: state.tenantUsage(auth.tenantId) });
});

// --- Wizard ---
app.post('/api/wizard/start', wrap(async (_req, res, auth) => {
  const session = state.startSession(auth.username, auth.tenantId);
  const { greeting, prompt } = state.builder.start();
  res.json({ sessionId: session.id, greeting, prompt: uiPrompt(prompt) });
}));

app.post('/api/wizard/answer', wrap(async (req, res, auth) => {
  const { sessionId, text } = (req.body ?? {}) as { sessionId?: string; text?: string };
  const session = state.getSession(String(sessionId));
  if (!session || session.ownerUsername !== auth.username) {
    res.sendStatus(404);
    return;
  }
  const r = await state.builder.submitText(session.values, String(text ?? ''));
  session.values = r.values;
  // After the conversational slots, insert the chat-selection step before confirming.
  if (r.complete && !session.selectedChats) {
    res.json({ prompt: { kind: 'select_chats', question: 'Which WhatsApp chats should this agent respond to? Search and select one or more.' }, complete: false, values: r.values });
    return;
  }
  res.json({ prompt: uiPrompt(r.prompt), complete: r.complete, values: r.values });
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
  if (!list.length) {
    res.status(400).json({ error: 'Select at least one chat.' });
    return;
  }
  session.selectedChats = list;
  const names = list.map((c) => c.name).join(', ');
  res.json({ prompt: { kind: 'confirm', text: `This agent will respond only in ${list.length} chat(s): ${names}. Ready to build it?` }, selected: list.length });
}));

app.post('/api/wizard/finalize', wrap(async (req, res, auth) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: string };
  const session = state.getSession(String(sessionId));
  if (!session || session.ownerUsername !== auth.username) {
    res.sendStatus(404);
    return;
  }
  const r = await state.builder.finalize(session.values);
  session.finalizeResult = r;
  res.json(r);
}));

app.post('/api/wizard/publish', wrap(async (req, res, auth) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: string };
  const session = state.getSession(String(sessionId));
  if (!session || session.ownerUsername !== auth.username) {
    res.sendStatus(404);
    return;
  }
  const agent = state.publish(session);
  state.bindChatsToAgent(agent.id, session.tenantId, session.selectedChats ?? []);
  res.json({ agentId: agent.id, listenChats: agent.listenChats, status: agent.status });
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
  res.json({ ...agentSummary(a), spec: a.spec, ownerUsername: a.ownerUsername, listenChats: a.listenChats });
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
});
