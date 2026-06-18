import './env';
import express, { type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { authenticate, tenantName } from './directory';
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

app.post('/api/login', (req: Request, res: Response) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
  const u = authenticate(String(username ?? ''), String(password ?? ''));
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

app.get('/api/whatsapp/status', wrap(async (_req, res) => {
  res.json(state.whatsappStatus());
}));

app.post('/api/agents/:id/connect-whatsapp', wrap(async (req, res, auth) => {
  const a = state.bindRealNumber(req.params.id, auth.tenantId);
  res.json({ id: a.id, phoneNumberId: a.phoneNumberId, boundAgentId: a.id });
}));

// --- QR-linked personal WhatsApp (POC) ---
app.post('/api/wa/link', wrap(async (_req, res) => {
  await state.startPersonalLink();
  res.json(state.personalLinkStatus());
}));

app.get('/api/wa/status', wrap(async (_req, res) => {
  res.json(state.personalLinkStatus());
}));

app.get('/api/wa/chats', wrap(async (req, res) => {
  res.json({ chats: state.listPersonalChats(String(req.query.q ?? '')) });
}));

app.post('/api/agents/:id/suggest', wrap(async (req, res, auth) => {
  const r = await state.suggestImprovements(req.params.id, auth.tenantId);
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

// --- Static SPA ---
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
app.use(express.static(publicDir));
app.get('*', (_req: Request, res: Response) => res.sendFile(`${publicDir}/index.html`));

const port = Number(process.env.PORT ?? 8080);
app.listen(port, '0.0.0.0', () => {
  console.log(`Whaser demo GUI on http://0.0.0.0:${port}  (login: alice/password, bob/password, carol/password)`);
});
