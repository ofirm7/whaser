import { AgentBuilder, AnthropicLlmClient, AnthropicTuner, applySuggestions, validateAgentSpec, checkConsistency } from '../../../packages/agent-builder/src/index';
import type { AgentSpec, SlotValues, Tuner, TranscriptTurn, TuningSuggestion, TuningResult } from '../../../packages/agent-builder/src/index';
import { InMemoryAgentResolver } from '../../../packages/whatsapp-gateway/src/agentResolver';
import { InMemoryConversationStore, conversationKey } from '../../../packages/whatsapp-gateway/src/conversationStore';
import { CircuitBreaker } from '../../../packages/whatsapp-gateway/src/circuitBreaker';
import { createAgentReplyHandler } from '../../../packages/whatsapp-gateway/src/agentReplyHandler';
import { hashSender } from '../../../packages/whatsapp-gateway/src/senderHash';
import { CloudApiClient } from '../../../packages/whatsapp-gateway/src/cloudApiClient';
import { InMemoryJobStore } from '../../../packages/whatsapp-gateway/src/inboundQueue';
import { InboundWorker } from '../../../packages/whatsapp-gateway/src/worker';
import type { InboundHandler, InboundMessage, JobStore } from '../../../packages/whatsapp-gateway/src/types';
import type { RuntimeMessage } from '../../../packages/whatsapp-gateway/src/agentRuntime';
import type { WorkflowLlm } from '../../../packages/agent-builder/src/index';
import { StubLlmClient, StubWorkflowLlm, StubTuner } from './stubs';
import { makeAnthropicLike, AnthropicWorkflowLlm } from './anthropic';
import { WorkflowAgentRuntime } from './workflowRuntime';
import { BaileysChannel } from './baileys';
import { loadAgents, saveAgents } from './persistence';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type RuntimeModeName = 'claude' | 'stub';

/** Virtual phone_number_id for the QR-linked personal WhatsApp channel. */
const WA_PERSONAL_PNID = 'wa-personal';

const SALT = 'whaser-demo-salt';

export interface ChatRef {
  id: string;
  name: string;
}

/** One inbound→routed→reply event, for the live activity log. */
export interface ActivityEvent {
  ts: number;
  tenantId: string;
  agentId: string;
  agentName: string;
  channel: 'sim' | 'whatsapp';
  chatId: string | null;
  from: string;
  text: string;
  routedTo: string | null;
  reply: string | null;
  blocked: string | null;
}

export interface StoredAgent {
  id: string;
  tenantId: string;
  ownerUsername: string;
  spec: AgentSpec;
  status: 'live' | 'paused';
  phoneNumberId: string;
  /** WhatsApp chats this agent listens on (allow-list). Empty = simulator-only. */
  listenChats: ChatRef[];
  createdAt: number;
  lastActivityAt: number | null;
}

/** A curated, ready-to-deploy agent in the global catalog (loaded from apps/web/catalog/*.json). */
export interface CatalogEntry {
  id: string;
  title: string;
  description: string;
  category: string;
  icon?: string;
  spec: AgentSpec;
}

export interface WizardSession {
  id: string;
  ownerUsername: string;
  tenantId: string;
  values: SlotValues;
  selectedChats: ChatRef[] | null;
  finalizeResult?: Awaited<ReturnType<AgentBuilder['finalize']>>;
}

export class AppState {
  /** 'claude' when ANTHROPIC_API_KEY is set, else 'stub'. */
  readonly mode: RuntimeModeName;
  readonly builder: AgentBuilder;
  private readonly agents = new Map<string, StoredAgent>();
  private readonly catalog = new Map<string, CatalogEntry>();
  private readonly sessions = new Map<string, WizardSession>();
  /** Monotonic source for SIM phone numbers — never reuses a number even if an agent is removed. */
  private simSeq = 0;
  private readonly resolver = new InMemoryAgentResolver();
  private readonly conversations = new InMemoryConversationStore();
  private readonly breaker = new CircuitBreaker({ perSenderPerMinute: 20, maxInboundChars: 4000, tenantDailyTokenBudget: 2_000_000 });
  private readonly runtime: WorkflowAgentRuntime;
  private readonly tuner: Tuner;
  private readonly handler: InboundHandler;
  private readonly lastBlock = new Map<string, string>();
  private readonly transcripts = new Map<string, TranscriptTurn[]>();
  private readonly activity: ActivityEvent[] = [];
  private seq = 0;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const getSpec = (agentId: string): AgentSpec | undefined => this.agents.get(agentId)?.spec;
    let workflowLlm: WorkflowLlm;
    if (apiKey) {
      this.mode = 'claude';
      this.builder = new AgentBuilder(new AnthropicLlmClient({ client: makeAnthropicLike(apiKey) }));
      workflowLlm = new AnthropicWorkflowLlm(apiKey);
      this.tuner = new AnthropicTuner({ client: makeAnthropicLike(apiKey) });
    } else {
      this.mode = 'stub';
      this.builder = new AgentBuilder(new StubLlmClient());
      workflowLlm = new StubWorkflowLlm();
      this.tuner = new StubTuner();
    }
    this.runtime = new WorkflowAgentRuntime(getSpec, workflowLlm);
    this.handler = createAgentReplyHandler({
      resolver: this.resolver,
      runtime: this.runtime,
      conversations: this.conversations,
      breaker: this.breaker,
      hashSalt: SALT,
      onBlocked: (reason, msg) => this.lastBlock.set(msg.waMessageId, reason),
    });

    // Persisted agents survive restarts: load them + re-bind their SIM number and chat allow-list.
    for (const a of loadAgents()) {
      this.agents.set(a.id, a);
      this.resolver.bind(a.phoneNumberId, { agentId: a.id, tenantId: a.tenantId });
      for (const c of a.listenChats) this.resolver.bind(c.id, { agentId: a.id, tenantId: a.tenantId });
      const m = a.phoneNumberId.match(/^SIM-(\d+)$/);
      if (m) this.simSeq = Math.max(this.simSeq, Number(m[1]) - 1000 + 1);
    }

    // Real WhatsApp Cloud API: enabled only when all four env vars are present.
    const env = process.env;
    if (env.WHATSAPP_VERIFY_TOKEN && env.WHATSAPP_APP_SECRET && env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
      this.waConfig = {
        verifyToken: env.WHATSAPP_VERIFY_TOKEN,
        appSecret: env.WHATSAPP_APP_SECRET,
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      };
      this.waStore = new InMemoryJobStore();
      const gateway = new CloudApiClient({ accessToken: env.WHATSAPP_ACCESS_TOKEN, graphVersion: env.WHATSAPP_GRAPH_VERSION ?? 'v21.0' });
      // Reuse the SAME WAT reply handler the simulator uses; the worker sends replies via Graph API.
      this.waWorker = new InboundWorker({ store: this.waStore, gateway, handler: this.handler, onError: (e, m) => console.error('[wa-worker]', m?.waMessageId, e) });
      this.waWorker.start();
    }

    // WhatsApp connected by default: auto-start the personal link (reconnects via .wa-auth
    // after the one-time QR scan). Fire-and-forget; errors are logged inside the channel.
    void this.startPersonalLink().catch((e) => console.error('[baileys] auto-start', e));

    // Load the global agents-catalog from committed seed files (once, at startup).
    this.loadCatalog();
  }

  // --- Real WhatsApp wiring (assigned in the constructor when env is present) ---
  private waConfig: { verifyToken: string; appSecret: string; phoneNumberId: string } | null = null;
  private waStore: JobStore | null = null;
  private waWorker: InboundWorker | null = null;
  private boundAgentId: string | null = null;

  /** Deps for the gateway webhook router, or null when WhatsApp isn't configured. */
  webhookDeps(): { verifyToken: string; appSecret: string; store: JobStore } | null {
    if (!this.waConfig || !this.waStore) return null;
    return { verifyToken: this.waConfig.verifyToken, appSecret: this.waConfig.appSecret, store: this.waStore };
  }

  whatsappStatus(): { configured: boolean; phoneNumberId: string | null; boundAgentId: string | null } {
    return { configured: this.waConfig != null, phoneNumberId: this.waConfig?.phoneNumberId ?? null, boundAgentId: this.boundAgentId };
  }

  /** Bind any channel's number to an agent so inbound messages for it route to that agent. */
  private bindNumber(agentId: string, tenantId: string, phoneNumberId: string): StoredAgent {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) throw new Error('agent not found');
    agent.phoneNumberId = phoneNumberId;
    this.resolver.bind(phoneNumberId, { agentId: agent.id, tenantId });
    return agent;
  }

  /** Bind the configured Cloud API number to an agent so inbound messages route to it. */
  bindRealNumber(agentId: string, tenantId: string): StoredAgent {
    if (!this.waConfig) throw new Error('WhatsApp is not configured (set WHATSAPP_* in apps/web/.env)');
    this.boundAgentId = agentId;
    return this.bindNumber(agentId, tenantId, this.waConfig.phoneNumberId);
  }

  /** Run an inbound message from any channel (e.g. the QR-linked personal WhatsApp) through the WAT pipeline. */
  async handleChannelInbound(phoneNumberId: string, from: string, text: string): Promise<{ reply: string | null; routedTo: string | null; blocked: string | null }> {
    const waMessageId = `ch-${++this.seq}`;
    const msg: InboundMessage = { waMessageId, from, phoneNumberId, type: 'text', text, timestamp: this.now() };
    const out = await this.handler(msg);
    const blocked = this.lastBlock.get(waMessageId) ?? null;
    const routedTo = out ? this.runtime.lastRoutedTo : null;
    const route = await this.resolver.resolve(phoneNumberId);
    if (route) {
      const t = this.transcripts.get(route.agentId) ?? [];
      t.push({ role: 'user', content: text });
      if (out?.text) t.push({ role: 'assistant', content: out.text });
      this.transcripts.set(route.agentId, t.slice(-40));
      const a = this.agents.get(route.agentId);
      if (a) a.lastActivityAt = this.now();
      this.logActivity({ ts: this.now(), tenantId: route.tenantId, agentId: route.agentId, agentName: a?.spec.agent_name ?? route.agentId, channel: 'whatsapp', chatId: phoneNumberId, from, text, routedTo, reply: out?.text ?? null, blocked });
    }
    return { reply: out?.text ?? null, routedTo, blocked };
  }

  // --- QR-linked personal WhatsApp (Baileys; POC only) ---
  private baileys: BaileysChannel | null = null;

  async startPersonalLink(): Promise<void> {
    if (!this.baileys) {
      // Resolve inbound by the FULL chat jid (used as the resolver key) so only chats an agent
      // has been bound to (its allow-list) get a reply.
      this.baileys = new BaileysChannel(async (jid, from, text) => (await this.handleChannelInbound(jid, from, text)).reply);
    }
    await this.baileys.start();
  }

  personalLinkStatus(): { status: string; qrDataUrl: string | null; me: string | null } {
    return this.baileys?.getStatus() ?? { status: 'disconnected', qrDataUrl: null, me: null };
  }

  /** Search the linked account's known chats/contacts (individuals + groups). */
  listPersonalChats(query: string): { id: string; name: string; isGroup: boolean }[] {
    return this.baileys ? this.baileys.listChats(query) : [];
  }

  /** Lazily resolve a linked-account chat's profile photo URL, or null if none/not linked. */
  async personalChatPhoto(jid: string): Promise<string | null> {
    return this.baileys ? this.baileys.profilePhoto(jid) : null;
  }

  /** Set an agent's chat allow-list and bind each chat jid to it (inbound for those chats → this agent). */
  bindChatsToAgent(agentId: string, tenantId: string, chats: ChatRef[]): StoredAgent {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) throw new Error('agent not found');
    agent.listenChats = chats;
    for (const c of chats) this.resolver.bind(c.id, { agentId: agent.id, tenantId });
    this.persist();
    return agent;
  }

  /** Replace an agent's chat allow-list after creation: unbind removed chats, bind added, persist. */
  editChats(agentId: string, tenantId: string, chats: ChatRef[]): StoredAgent {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) throw new Error('agent not found');
    const newIds = new Set(chats.map((c) => c.id));
    for (const c of agent.listenChats) if (!newIds.has(c.id)) this.resolver.unbind(c.id);
    agent.listenChats = chats;
    for (const c of chats) this.resolver.bind(c.id, { agentId: agent.id, tenantId });
    this.persist();
    return agent;
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq.toString(36)}${Math.floor(this.now() % 1000).toString(36)}`;
  }

  private now(): number {
    return Date.now();
  }

  private persist(): void {
    saveAgents([...this.agents.values()]);
  }

  private logActivity(e: ActivityEvent): void {
    this.activity.push(e);
    if (this.activity.length > 300) this.activity.splice(0, this.activity.length - 300);
  }

  /** Recent inbound→routed→reply events for a tenant (optionally one agent), newest first. */
  recentActivity(tenantId: string, agentId?: string, limit = 100): ActivityEvent[] {
    return this.activity.filter((e) => e.tenantId === tenantId && (!agentId || e.agentId === agentId)).slice(-limit).reverse();
  }

  /** Mint the next simulator phone_number_id. Monotonic so two agents never collide on a number. */
  private nextSimNumber(): string {
    return `SIM-${1000 + this.simSeq++}`;
  }

  // --- Wizard ---
  startSession(ownerUsername: string, tenantId: string): WizardSession {
    const session: WizardSession = { id: this.id('ws'), ownerUsername, tenantId, values: {}, selectedChats: null };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): WizardSession | undefined {
    return this.sessions.get(id);
  }

  // --- Agents ---
  listAgents(tenantId: string): StoredAgent[] {
    return [...this.agents.values()].filter((a) => a.tenantId === tenantId).sort((a, b) => b.createdAt - a.createdAt);
  }

  getAgent(id: string, tenantId: string): StoredAgent | undefined {
    const a = this.agents.get(id);
    return a && a.tenantId === tenantId ? a : undefined;
  }

  publish(session: WizardSession): StoredAgent {
    const result = session.finalizeResult;
    if (!result || !result.publishable) throw new Error('spec is not publishable');
    const spec = result.spec as AgentSpec;
    const agent: StoredAgent = {
      id: this.id('agent'),
      tenantId: session.tenantId,
      ownerUsername: session.ownerUsername,
      spec,
      status: 'live',
      phoneNumberId: this.nextSimNumber(),
      listenChats: [],
      createdAt: this.now(),
      lastActivityAt: null,
    };
    this.agents.set(agent.id, agent);
    this.resolver.bind(agent.phoneNumberId, { agentId: agent.id, tenantId: agent.tenantId });
    this.persist();
    return agent;
  }

  // --- Catalog (global, curated, deploy-as-is) ---

  /** Load and validate every catalog seed file at apps/web/catalog/*.json. Invalid entries are skipped. */
  private loadCatalog(): void {
    const dir = fileURLToPath(new URL('../catalog', import.meta.url));
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const stem = file.replace(/\.json$/, '');
      try {
        const entry = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as CatalogEntry;
        const meta = ['id', 'title', 'description', 'category'] as const;
        for (const k of meta) {
          if (typeof entry[k] !== 'string' || !entry[k].trim()) throw new Error(`missing/empty "${k}"`);
        }
        if (entry.id !== stem) throw new Error(`id "${entry.id}" must equal filename stem "${stem}"`);
        if (this.catalog.has(entry.id)) throw new Error(`duplicate catalog id "${entry.id}"`);
        const schema = validateAgentSpec(entry.spec);
        if (!schema.valid) throw new Error(`invalid spec: ${schema.errors.join('; ')}`);
        const issues = checkConsistency(entry.spec);
        if (issues.length) throw new Error(`inconsistent spec: ${issues.map((i) => i.message).join('; ')}`);
        this.catalog.set(entry.id, entry);
      } catch (e) {
        console.warn(`[catalog] skipping ${file}:`, e instanceof Error ? e.message : e);
      }
    }
  }

  listCatalog(): CatalogEntry[] {
    return [...this.catalog.values()].sort((a, b) => (a.category + a.title).localeCompare(b.category + b.title));
  }

  getCatalogEntry(id: string): CatalogEntry | undefined {
    return this.catalog.get(id);
  }

  /** Deploy a catalog entry as-is into a tenant: a fresh live agent on its own SIM number. */
  deployFromCatalog(catalogId: string, ownerUsername: string, tenantId: string): StoredAgent {
    const entry = this.catalog.get(catalogId);
    if (!entry) throw new Error('catalog entry not found');
    // Deep-clone so deploys never share/mutate the catalog master (self-tuning edits agent.spec in place).
    const spec = JSON.parse(JSON.stringify(entry.spec)) as AgentSpec;
    const agent: StoredAgent = {
      id: this.id('agent'),
      tenantId,
      ownerUsername,
      spec,
      status: 'live',
      phoneNumberId: this.nextSimNumber(),
      listenChats: [],
      createdAt: this.now(),
      lastActivityAt: null,
    };
    this.agents.set(agent.id, agent);
    this.resolver.bind(agent.phoneNumberId, { agentId: agent.id, tenantId });
    this.persist();
    return agent;
  }

  setStatus(id: string, tenantId: string, status: 'live' | 'paused'): StoredAgent | undefined {
    const a = this.getAgent(id, tenantId);
    if (!a) return undefined;
    a.status = status;
    this.persist();
    return a;
  }

  // --- WhatsApp simulator (exercises the real gateway pipeline) ---
  async simulateInbound(agentId: string, tenantId: string, from: string, text: string): Promise<{ reply: string | null; blocked: string | null; status: string; routedTo: string | null } | null> {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) return null;
    if (agent.status !== 'live') return { reply: null, blocked: 'agent_paused', status: agent.status, routedTo: null };
    const waMessageId = `sim-${++this.seq}`;
    const msg: InboundMessage = { waMessageId, from, phoneNumberId: agent.phoneNumberId, type: 'text', text, timestamp: this.now() };
    const out = await this.handler(msg);
    agent.lastActivityAt = this.now();
    const blocked = this.lastBlock.get(waMessageId) ?? null;
    const routedTo = out ? this.runtime.lastRoutedTo : null;
    // Record a flat per-agent transcript for self-tuning (capped).
    const t = this.transcripts.get(agentId) ?? [];
    t.push({ role: 'user', content: text });
    if (out?.text) t.push({ role: 'assistant', content: out.text });
    this.transcripts.set(agentId, t.slice(-40));
    this.logActivity({ ts: this.now(), tenantId, agentId, agentName: agent.spec.agent_name, channel: 'sim', chatId: null, from, text, routedTo, reply: out?.text ?? null, blocked });
    return { reply: out?.text ?? null, blocked, status: agent.status, routedTo };
  }

  // --- Self-improvement (spec self-tuning from transcripts) ---
  async suggestImprovements(agentId: string, tenantId: string): Promise<TuningResult | null> {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) return null;
    return this.tuner.suggest({ spec: agent.spec, transcripts: this.transcripts.get(agentId) ?? [] });
  }

  applyImprovements(agentId: string, tenantId: string, suggestions: TuningSuggestion[]): StoredAgent {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) throw new Error('agent not found');
    const next = applySuggestions(agent.spec, suggestions);
    const schema = validateAgentSpec(next);
    if (!schema.valid) throw new Error(`improved spec invalid: ${schema.errors.join('; ')}`);
    const issues = checkConsistency(next);
    if (issues.length) throw new Error(`improved spec inconsistent: ${issues.map((i) => i.message).join('; ')}`);
    agent.spec = next;
    this.persist();
    return agent;
  }

  async history(agentId: string, tenantId: string, from: string): Promise<RuntimeMessage[]> {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) return [];
    return this.conversations.history(conversationKey(agentId, hashSender(from, SALT)));
  }

  tenantUsage(tenantId: string): number {
    return this.breaker.usage(tenantId);
  }
}
