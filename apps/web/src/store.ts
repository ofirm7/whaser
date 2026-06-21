import { AgentBuilder, AnthropicLlmClient, AnthropicTuner, AnthropicExtender, applySuggestions, applyExtension, validateAgentSpec, checkConsistency } from '../../../packages/agent-builder/src/index';
import type { AgentSpec, SlotValues, Tuner, TranscriptTurn, TuningSuggestion, TuningResult, Extender, ExtensionKind, SpecExtension, InterviewTurn } from '../../../packages/agent-builder/src/index';
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
import { StubLlmClient, StubWorkflowLlm, StubTuner, StubExtender } from './stubs';
import { makeAnthropicLike, AnthropicWorkflowLlm } from './anthropic';
import { WorkflowAgentRuntime } from './workflowRuntime';
import { BaileysChannel } from './baileys';
import { TriggerScheduler } from './scheduler';
import { loadAgents, saveAgents } from './persistence';
import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, renameSync } from 'node:fs';
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
  channel: 'sim' | 'whatsapp' | 'timer';
  chatId: string | null;
  from: string;
  text: string;
  routedTo: string | null;
  reply: string | null;
  blocked: string | null;
}

/** Wall-clock ms per cadence unit. */
const UNIT_MS = { second: 1e3, minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5 } as const;
export type TimeUnit = keyof typeof UNIT_MS;
/** Floor enforced at FIRE time: 'second' stays a legal unit but a trigger never fires faster than this. */
export const MIN_INTERVAL_MS = 30_000;
/** Max chats a single fire fans out to (outbound safety cap). */
const MAX_TRIGGER_CHATS = 20;
/** Per-tenant successful-fire circuit breaker per UTC day. */
export const DAILY_FIRE_BUDGET = 500;

/** A scheduled action the agent runs automatically on a cadence (sends to its chats + logs it). */
export interface AgentTrigger {
  id: string;
  label: string;
  /** The instruction run through the agent each time it fires. */
  prompt: string;
  enabled: boolean;
  value: number;
  unit: TimeUnit;
  /** Optional link to the spec tool that seeded this trigger (isTimedTool hint). */
  toolName?: string;
  lastRunAt: number | null;
  lastStatus: 'ok' | 'error' | 'skipped' | null;
  lastError: string | null;
  lastSentCount: number | null;
  consecutiveErrors: number;
  createdAt: number;
  updatedAt: number;
}

/** The wall-clock interval of a trigger in ms (before the MIN_INTERVAL floor / backoff). */
export function intervalMs(t: { value: number; unit: TimeUnit }): number {
  return t.value * UNIT_MS[t.unit];
}

/** A spec tool reads as time-based when it's side-effecting AND scheduled/recurring — a UI hint only. */
export function isTimedTool(tool: { name?: string; description?: string; side_effecting?: boolean }): boolean {
  return (
    tool?.side_effecting === true &&
    /schedul|remind|recurr|every\s+(sec|min|hour|day|week|morning)|timed|timer|periodic|follow.?up|cron|interval|cadence|digest|poll/i.test(
      `${tool.name ?? ''} ${tool.description ?? ''}`,
    )
  );
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
  /** Scheduled actions that fire automatically on a cadence. Absent until the owner adds one. */
  triggers?: AgentTrigger[];
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
  /** Free-form agent-design conversation (the conversational builder; replaces slot Q&A). */
  messages: InterviewTurn[];
  selectedChats: ChatRef[] | null;
  finalizeResult?: Awaited<ReturnType<AgentBuilder['finalize']>>;
}

/** A trigger to create (cadence + action), plus capabilities to add to the agent first. */
export interface TriggerProposal {
  trigger: { label: string; prompt: string; value: number; unit: TimeUnit };
  extensions: SpecExtension[];
}

/** A scoped conversation for designing one timed action for an existing agent. */
export interface TriggerSession {
  id: string;
  ownerUsername: string;
  tenantId: string;
  agentId: string;
  messages: InterviewTurn[];
  plan?: TriggerProposal;
}

const TRIGGER_BUILDER_GREETING =
  "Let's set up an action this agent runs automatically on a schedule. Tell me what it should do and how " +
  "often (e.g. \"every morning\", \"every 2 hours\"). I'll build any tools or skills it needs, then create the trigger.";

export class AppState {
  /** 'claude' when ANTHROPIC_API_KEY is set, else 'stub'. */
  readonly mode: RuntimeModeName;
  readonly builder: AgentBuilder;
  private readonly agents = new Map<string, StoredAgent>();
  private readonly catalog = new Map<string, CatalogEntry>();
  private readonly sessions = new Map<string, WizardSession>();
  private readonly triggerSessions = new Map<string, TriggerSession>();
  /** Monotonic source for SIM phone numbers — never reuses a number even if an agent is removed. */
  private simSeq = 0;
  private readonly resolver = new InMemoryAgentResolver();
  private readonly conversations = new InMemoryConversationStore();
  private readonly breaker = new CircuitBreaker({ perSenderPerMinute: 20, maxInboundChars: 4000, tenantDailyTokenBudget: 2_000_000 });
  private readonly runtime: WorkflowAgentRuntime;
  private readonly tuner: Tuner;
  private readonly extender: Extender;
  private readonly handler: InboundHandler;
  private readonly scheduler: TriggerScheduler;
  /** Trigger ids currently firing — shared overlap guard for the scheduler AND manual "Run now". */
  private readonly firing = new Set<string>();
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
      this.extender = new AnthropicExtender({ client: makeAnthropicLike(apiKey) });
    } else {
      this.mode = 'stub';
      this.builder = new AgentBuilder(new StubLlmClient());
      workflowLlm = new StubWorkflowLlm();
      this.tuner = new StubTuner();
      this.extender = new StubExtender();
    }
    // Steer each reply into the agent owner's personal writing style — per-tenant samples, resolved
    // per-call inside the runtime for the agent being replied to (race-free across tenants).
    this.runtime = new WorkflowAgentRuntime(getSpec, workflowLlm, (agentId) => this.ownerStylePreambleForAgent(agentId));
    this.handler = createAgentReplyHandler({
      resolver: this.resolver,
      runtime: this.runtime,
      conversations: this.conversations,
      breaker: this.breaker,
      hashSalt: SALT,
      onBlocked: (reason, msg) => this.lastBlock.set(msg.waMessageId, reason),
    });

    // Persisted agents survive restarts: load them + re-bind their SIM number and chat allow-list
    // (chat keys are tenant-scoped so the same contact in two users' accounts can't collide).
    for (const a of loadAgents()) {
      delete (a as { timing?: unknown }).timing; // drop the superseded per-tool timing field (now: triggers)
      this.agents.set(a.id, a);
      this.resolver.bind(a.phoneNumberId, { agentId: a.id, tenantId: a.tenantId });
      for (const c of a.listenChats) this.resolver.bind(this.chatKey(a.tenantId, c.id), { agentId: a.id, tenantId: a.tenantId });
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

    // Per-user WhatsApp: migrate the legacy single link into tenant "acme" once, then reconnect
    // every tenant that has linked before (each its own channel). New users link on demand.
    this.migrateLegacyLink();
    for (const t of this.linkedTenants()) void this.channelFor(t).start().catch((e) => console.error('[baileys] auto-start', t, e));

    // Load the global agents-catalog from committed seed files (once, at startup).
    this.loadCatalog();

    // Auto-fire scheduled triggers (started last, after agents are rehydrated). Disabled triggers
    // never fire, so this is dormant until an owner enables one.
    this.scheduler = new TriggerScheduler(this);
    this.scheduler.start();
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

  /** Run an inbound message from a tenant's personal WhatsApp through the WAT pipeline. */
  async handleChannelInbound(tenantId: string, jid: string, from: string, text: string, media?: { kind: 'image' | 'document'; base64: string; mediaType: string; filename?: string }): Promise<{ reply: string | null; routedTo: string | null; blocked: string | null }> {
    const waMessageId = `ch-${++this.seq}`;
    const key = this.chatKey(tenantId, jid); // tenant-scoped so two users can't collide on a contact
    const msg: InboundMessage = { waMessageId, from, phoneNumberId: key, type: 'text', text, currentTurnMedia: media, timestamp: this.now() };
    const out = await this.handler(msg);
    const blocked = this.lastBlock.get(waMessageId) ?? null;
    const routedTo = out ? this.runtime.lastRoutedTo : null;
    const route = await this.resolver.resolve(key);
    if (route) {
      const t = this.transcripts.get(route.agentId) ?? [];
      t.push({ role: 'user', content: text });
      if (out?.text) t.push({ role: 'assistant', content: out.text });
      this.transcripts.set(route.agentId, t.slice(-40));
      const a = this.agents.get(route.agentId);
      if (a) a.lastActivityAt = this.now();
      this.logActivity({ ts: this.now(), tenantId: route.tenantId, agentId: route.agentId, agentName: a?.spec.agent_name ?? route.agentId, channel: 'whatsapp', chatId: jid, from, text, routedTo, reply: out?.text ?? null, blocked });
    }
    return { reply: out?.text ?? null, routedTo, blocked };
  }

  // --- Per-user QR-linked personal WhatsApp (Baileys; POC only) ---
  private readonly channels = new Map<string, BaileysChannel>();
  private chatKey(tenantId: string, jid: string): string { return `${tenantId}::${jid}`; }

  /** Lazily create the tenant's own WhatsApp channel (own auth/chats/style, isolated inbound). */
  private channelFor(tenantId: string): BaileysChannel {
    let ch = this.channels.get(tenantId);
    if (!ch) {
      ch = new BaileysChannel(tenantId, async (jid, from, text, media) => (await this.handleChannelInbound(tenantId, jid, from, text, media)).reply);
      this.channels.set(tenantId, ch);
    }
    return ch;
  }

  /** Tenants that have linked before (have persisted creds) — reconnected on boot. */
  private linkedTenants(): string[] {
    const root = fileURLToPath(new URL('../.wa-auth', import.meta.url));
    if (!existsSync(root)) return [];
    const out: string[] = [];
    for (const d of readdirSync(root)) {
      try { if (statSync(`${root}/${d}`).isDirectory() && existsSync(`${root}/${d}/creds.json`)) out.push(d); } catch { /* ignore */ }
    }
    return out;
  }

  /** One-time: move the legacy single link (.wa-auth root + .data/wa-*.json) into tenant "acme". */
  private migrateLegacyLink(): void {
    try {
      const root = fileURLToPath(new URL('../.wa-auth', import.meta.url));
      const acme = `${root}/acme`;
      if (existsSync(`${root}/creds.json`) && !existsSync(acme)) {
        mkdirSync(acme, { recursive: true });
        for (const f of readdirSync(root)) {
          if (f === 'acme') continue;
          try { if (statSync(`${root}/${f}`).isFile()) renameSync(`${root}/${f}`, `${acme}/${f}`); } catch { /* ignore */ }
        }
        const data = fileURLToPath(new URL('../.data', import.meta.url));
        for (const [from, to] of [['wa-chats.json', 'wa-chats-acme.json'], ['wa-owner-style.json', 'wa-owner-style-acme.json']]) {
          try { if (existsSync(`${data}/${from}`) && !existsSync(`${data}/${to}`)) renameSync(`${data}/${from}`, `${data}/${to}`); } catch { /* ignore */ }
        }
        console.log('[baileys] migrated legacy link -> tenant acme');
      }
    } catch (e) { console.error('[baileys] legacy migration failed', e); }
  }

  async startPersonalLink(tenantId: string): Promise<void> {
    await this.channelFor(tenantId).start();
  }

  personalLinkStatus(tenantId: string): { status: string; qrDataUrl: string | null; me: string | null } {
    const ch = this.channelFor(tenantId);
    if (ch.getStatus().status === 'disconnected') void ch.start().catch((e) => console.error('[baileys] start', tenantId, e));
    return ch.getStatus();
  }

  /** Search the tenant's linked account's known chats/contacts (individuals + groups). */
  listPersonalChats(tenantId: string, query: string): { id: string; name: string; isGroup: boolean }[] {
    return this.channels.get(tenantId)?.listChats(query) ?? [];
  }

  /** Lazily resolve a chat's profile photo URL for the tenant's linked account, or null. */
  async personalChatPhoto(tenantId: string, jid: string): Promise<string | null> {
    return this.channels.get(tenantId)?.profilePhoto(jid) ?? null;
  }

  /** Style preamble for the agent's tenant ('' if no samples) — applied to that agent's replies. */
  private ownerStylePreambleForAgent(agentId: string): string {
    const agent = this.agents.get(agentId);
    const samples = agent ? this.channels.get(agent.tenantId)?.ownerStyleSamples(25) ?? [] : [];
    if (!samples.length) return '';
    const list = samples.map((s) => `- ${s.replace(/\s+/g, ' ').trim()}`).join('\n');
    return (
      'VOICE — Write every reply as the account owner themselves: mirror their language, exact spelling ' +
      'and slang/abbreviations (keep their informal forms and transliteration), punctuation, capitalization, ' +
      'sentence length and structure, formality, and emoji usage. Reply in the same language they use; do not ' +
      "sound like a generic assistant. Keep the agent's goal and scope, but the VOICE must be the owner's.\n" +
      'Examples of how the owner writes:\n' + list
    );
  }

  /** Set an agent's chat allow-list and bind each chat jid (tenant-scoped) to it. */
  bindChatsToAgent(agentId: string, tenantId: string, chats: ChatRef[]): StoredAgent {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) throw new Error('agent not found');
    agent.listenChats = chats;
    for (const c of chats) this.resolver.bind(this.chatKey(tenantId, c.id), { agentId: agent.id, tenantId });
    this.persist();
    return agent;
  }

  /** Replace an agent's chat allow-list after creation: unbind removed chats, bind added, persist. */
  editChats(agentId: string, tenantId: string, chats: ChatRef[]): StoredAgent {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) throw new Error('agent not found');
    const newIds = new Set(chats.map((c) => c.id));
    for (const c of agent.listenChats) if (!newIds.has(c.id)) this.resolver.unbind(this.chatKey(tenantId, c.id));
    agent.listenChats = chats;
    for (const c of chats) this.resolver.bind(this.chatKey(tenantId, c.id), { agentId: agent.id, tenantId });
    this.persist();
    return agent;
  }

  // --- Scheduled triggers (auto-firing timed actions) ---

  /** Every agent across tenants — the scheduler iterates these each tick. */
  eachAgent(): StoredAgent[] {
    return [...this.agents.values()];
  }

  private normalizeUnit(u: unknown): TimeUnit {
    const UNITS: readonly string[] = ['second', 'minute', 'hour', 'day', 'week'];
    return UNITS.includes(u as string) ? (u as TimeUnit) : 'minute';
  }

  private clampInterval(v: unknown): number {
    return Math.max(1, Math.min(9999, Math.round(Number(v) || 1)));
  }

  /** Create a scheduled trigger. ALWAYS created disabled — the owner enables it explicitly. */
  addTrigger(agentId: string, tenantId: string, cfg: { label?: unknown; prompt?: unknown; value?: unknown; unit?: unknown; enabled?: unknown; toolName?: unknown }): AgentTrigger {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) throw new Error('agent not found');
    const prompt = String(cfg.prompt ?? '').trim();
    if (!prompt) throw new Error('a trigger needs an action prompt');
    const now = this.now();
    const trigger: AgentTrigger = {
      id: this.id('trg'),
      label: String(cfg.label ?? '').trim() || 'Timed action',
      prompt,
      enabled: cfg.enabled === true,
      value: this.clampInterval(cfg.value),
      unit: this.normalizeUnit(cfg.unit),
      toolName: typeof cfg.toolName === 'string' ? cfg.toolName : undefined,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      lastSentCount: null,
      consecutiveErrors: 0,
      createdAt: now,
      updatedAt: now,
    };
    agent.triggers = [...(agent.triggers ?? []), trigger];
    this.persist();
    return trigger;
  }

  /** Patch a trigger (partial). Re-validates value/unit; keeps label/prompt non-empty when provided. */
  updateTrigger(agentId: string, tenantId: string, trgId: string, patch: { label?: unknown; prompt?: unknown; value?: unknown; unit?: unknown; enabled?: unknown }): AgentTrigger {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) throw new Error('agent not found');
    const trigger = (agent.triggers ?? []).find((t) => t.id === trgId);
    if (!trigger) throw new Error('trigger not found');
    if (patch.label !== undefined) { const l = String(patch.label).trim(); if (l) trigger.label = l; }
    if (patch.prompt !== undefined) { const p = String(patch.prompt).trim(); if (p) trigger.prompt = p; }
    if (patch.value !== undefined) trigger.value = this.clampInterval(patch.value);
    if (patch.unit !== undefined) trigger.unit = this.normalizeUnit(patch.unit);
    if (patch.enabled !== undefined) {
      const wasEnabled = trigger.enabled;
      trigger.enabled = patch.enabled === true;
      // Anchor the cadence at enable time so a just-enabled trigger waits one full interval (no instant fire).
      if (!wasEnabled && trigger.enabled) trigger.lastRunAt = this.now();
    }
    trigger.updatedAt = this.now();
    this.persist();
    return trigger;
  }

  /** Delete a trigger; returns true if it existed. */
  deleteTrigger(agentId: string, tenantId: string, trgId: string): boolean {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) throw new Error('agent not found');
    const before = (agent.triggers ?? []).length;
    agent.triggers = (agent.triggers ?? []).filter((t) => t.id !== trgId);
    if (agent.triggers.length === before) return false;
    this.persist();
    return true;
  }

  /**
   * Fire one trigger: run its action through the agent runtime, send the result to the agent's
   * WhatsApp chats (when linked), and log a 'timer' activity event. Records run status + backoff.
   * The scheduler calls this for due, enabled, live triggers; `force` is for the manual "Run now".
   */
  /** True while this trigger is mid-fire (the scheduler checks this to avoid overlapping/double-counting). */
  isFiring(trgId: string): boolean {
    return this.firing.has(trgId);
  }

  async fireTrigger(agentId: string, trigger: AgentTrigger, opts?: { force?: boolean }): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (!opts?.force && (agent.status !== 'live' || !trigger.enabled)) return;
    if (this.firing.has(trigger.id)) return; // overlap guard: a fire (scheduled or manual) is already in flight
    this.firing.add(trigger.id);
    try {
      const out = await this.runtime.complete({ agentId, messages: [{ role: 'user', content: trigger.prompt }] });
      const text = (out.text ?? '').trim();
      const ch = this.channels.get(agent.tenantId);
      const connected = ch?.getStatus().status === 'connected';
      let sent = 0;
      if (text && connected) {
        for (const c of agent.listenChats.slice(0, MAX_TRIGGER_CHATS)) {
          if (await ch!.sendText(c.id, text)) sent++;
        }
      }
      this.logActivity({
        ts: this.now(), tenantId: agent.tenantId, agentId, agentName: agent.spec.agent_name,
        channel: 'timer', chatId: null, from: `trigger:${trigger.label}`, text: trigger.prompt,
        routedTo: this.runtime.lastRoutedTo, reply: text || null,
        blocked: connected ? null : (agent.listenChats.length ? 'not_linked' : 'sim_only'),
      });
      agent.lastActivityAt = this.now();
      trigger.lastRunAt = this.now();
      trigger.lastStatus = 'ok';
      trigger.lastError = null;
      trigger.lastSentCount = sent;
      trigger.consecutiveErrors = 0;
    } catch (e) {
      trigger.lastStatus = 'error';
      trigger.lastError = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      trigger.consecutiveErrors = (trigger.consecutiveErrors ?? 0) + 1;
      trigger.lastRunAt = this.now();
      trigger.lastSentCount = null;
    } finally {
      trigger.updatedAt = this.now();
      this.firing.delete(trigger.id);
      this.persist();
    }
  }

  /** Manually fire a trigger now ("Run now") — an explicit owner action, so it ignores enabled/live gates. */
  async runTriggerNow(agentId: string, tenantId: string, trgId: string): Promise<AgentTrigger> {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) throw new Error('agent not found');
    const trigger = (agent.triggers ?? []).find((t) => t.id === trgId);
    if (!trigger) throw new Error('trigger not found');
    await this.fireTrigger(agentId, trigger, { force: true });
    return trigger;
  }

  // --- AI "add timed action" builder: conversational, auto-builds capabilities, then creates a trigger ---

  startTriggerBuilder(agentId: string, tenantId: string, owner: string): { sessionId: string; greeting: string } | null {
    if (!this.getAgent(agentId, tenantId)) return null;
    const id = this.id('tb');
    this.triggerSessions.set(id, { id, ownerUsername: owner, tenantId, agentId, messages: [] });
    return { sessionId: id, greeting: TRIGGER_BUILDER_GREETING };
  }

  async triggerBuilderMessage(sessionId: string, owner: string, text: string): Promise<{ reply: string; readyToBuild: boolean; buildNow: boolean } | null> {
    const s = this.triggerSessions.get(sessionId);
    if (!s || s.ownerUsername !== owner) return null;
    const agent = this.getAgent(s.agentId, s.tenantId);
    if (!agent) return null;
    s.messages.push({ role: 'user', content: text });
    const r = await this.builder.interviewTrigger(agent.spec, s.messages);
    s.messages.push({ role: 'assistant', content: r.reply });
    return r;
  }

  /** Synthesize the plan + materialize each capability request into a reviewable SpecExtension (no side effects). */
  async proposeTriggerPlan(sessionId: string, owner: string): Promise<TriggerProposal | null> {
    const s = this.triggerSessions.get(sessionId);
    if (!s || s.ownerUsername !== owner) return null;
    const agent = this.getAgent(s.agentId, s.tenantId);
    if (!agent) return null;
    const plan = await this.builder.synthesizeTrigger(agent.spec, s.messages);
    const extensions: SpecExtension[] = [];
    for (const req of plan.capabilityRequests ?? []) {
      if ((req.kind !== 'context' && req.kind !== 'skill' && req.kind !== 'workflow') || !String(req.instruction ?? '').trim()) continue;
      extensions.push(await this.extender.propose({ spec: agent.spec, kind: req.kind, instruction: String(req.instruction), prior: null }));
    }
    s.plan = {
      trigger: {
        label: String(plan.label ?? '').trim() || 'Timed action',
        prompt: String(plan.prompt ?? '').trim() || 'Send a short update.',
        value: Math.max(1, Math.min(9999, Math.round(Number(plan.value) || 1))),
        unit: this.normalizeUnit(plan.unit),
      },
      extensions,
    };
    return s.plan;
  }

  /** Apply the proposed capabilities (validated via applyExtension), then create the trigger (DISABLED).
   *  Atomic: if any capability fails validation, the spec is rolled back so no partial state is persisted. */
  applyTriggerPlan(sessionId: string, owner: string): { agentId: string; version: number; trigger: AgentTrigger; appliedCapabilities: number } | null {
    const s = this.triggerSessions.get(sessionId);
    if (!s || s.ownerUsername !== owner) return null;
    const agent = this.getAgent(s.agentId, s.tenantId);
    if (!agent) return null;
    if (!s.plan) throw new Error('no proposed plan — propose first');
    const before = JSON.parse(JSON.stringify(agent.spec)) as AgentSpec; // snapshot for rollback
    try {
      let applied = 0;
      for (const ext of s.plan.extensions) {
        this.applyExtension(s.agentId, s.tenantId, ext); // validates + consistency-checks + version-bumps; throws on bad
        applied++;
      }
      const trigger = this.addTrigger(s.agentId, s.tenantId, { ...s.plan.trigger, enabled: false });
      this.triggerSessions.delete(sessionId);
      return { agentId: s.agentId, version: agent.spec.version, trigger, appliedCapabilities: applied };
    } catch (e) {
      agent.spec = before; // roll back any partially-applied capabilities
      this.persist();
      throw e;
    }
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
    const session: WizardSession = { id: this.id('ws'), ownerUsername, tenantId, values: {}, messages: [], selectedChats: null };
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

  /** Permanently remove an agent: unbind its number + chat allow-list, drop its conversation
   *  state (transcripts + per-sender history), clear the Cloud-API binding if it points here, persist. */
  async deleteAgent(id: string, tenantId: string): Promise<boolean> {
    const agent = this.getAgent(id, tenantId);
    if (!agent) return false;
    this.resolver.unbind(agent.phoneNumberId);
    for (const c of agent.listenChats) this.resolver.unbind(this.chatKey(tenantId, c.id));
    this.agents.delete(id);
    this.transcripts.delete(id);
    await this.conversations.purge(id);
    if (this.boundAgentId === id) this.boundAgentId = null;
    this.persist();
    return true;
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
  async suggestImprovements(agentId: string, tenantId: string, instruction?: string): Promise<TuningResult | null> {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) return null;
    return this.tuner.suggest({ spec: agent.spec, transcripts: this.transcripts.get(agentId) ?? [], instruction });
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

  // --- Extend an existing agent: Context / Skills / Workflows ---
  /** AI-draft a spec extension (prior powers the "Ask Changes" loop). */
  async proposeExtension(agentId: string, tenantId: string, kind: ExtensionKind, instruction: string, prior?: SpecExtension | null): Promise<SpecExtension | null> {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) return null;
    return this.extender.propose({ spec: agent.spec, kind, instruction, prior: prior ?? null });
  }

  /** Wrap free text (e.g. an uploaded file) as a ready-to-apply context extension (no LLM). */
  contextFromText(label: string, text: string): SpecExtension {
    const content = (text ?? '').trim().slice(0, 12000);
    const lbl = (label ?? '').trim() || 'note';
    return { kind: 'context', summary: `Add "${lbl}" (${content.length} chars) as knowledge.`, knowledge: [{ type: 'text', label: lbl, content }] };
  }

  /** Fetch a URL, strip HTML to text, and wrap as a context extension (fallback: store the link). */
  async contextFromUrl(url: string): Promise<SpecExtension> {
    const u = (url ?? '').trim();
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(8000) });
      const html = await res.text();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 8000);
      if (text) return { kind: 'context', summary: `Fetched ${u} (${text.length} chars).`, knowledge: [{ type: 'text', label: u, content: text }] };
    } catch {
      /* fall through to storing the link */
    }
    return { kind: 'context', summary: `Store link ${u} (fetch failed/empty).`, knowledge: [{ type: 'url', label: u, content: u }] };
  }

  /** Apply an approved extension: re-validate + consistency-check, then persist + version-bump. */
  applyExtension(agentId: string, tenantId: string, ext: SpecExtension): StoredAgent {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) throw new Error('agent not found');
    const next = applyExtension(agent.spec, ext);
    const schema = validateAgentSpec(next);
    if (!schema.valid) throw new Error(`extended spec invalid: ${schema.errors.join('; ')}`);
    const issues = checkConsistency(next);
    if (issues.length) throw new Error(`extended spec inconsistent: ${issues.map((i) => i.message).join('; ')}`);
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
