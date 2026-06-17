import { AgentBuilder, AnthropicLlmClient, AnthropicTuner, applySuggestions, validateAgentSpec, checkConsistency } from '../../../packages/agent-builder/src/index';
import type { AgentSpec, SlotValues, Tuner, TranscriptTurn, TuningSuggestion, TuningResult } from '../../../packages/agent-builder/src/index';
import { InMemoryAgentResolver } from '../../../packages/whatsapp-gateway/src/agentResolver';
import { InMemoryConversationStore, conversationKey } from '../../../packages/whatsapp-gateway/src/conversationStore';
import { CircuitBreaker } from '../../../packages/whatsapp-gateway/src/circuitBreaker';
import { createAgentReplyHandler } from '../../../packages/whatsapp-gateway/src/agentReplyHandler';
import { hashSender } from '../../../packages/whatsapp-gateway/src/senderHash';
import type { InboundHandler, InboundMessage } from '../../../packages/whatsapp-gateway/src/types';
import type { RuntimeMessage } from '../../../packages/whatsapp-gateway/src/agentRuntime';
import type { WorkflowLlm } from '../../../packages/agent-builder/src/index';
import { StubLlmClient, StubWorkflowLlm, StubTuner } from './stubs';
import { makeAnthropicLike, AnthropicWorkflowLlm } from './anthropic';
import { WorkflowAgentRuntime } from './workflowRuntime';

export type RuntimeModeName = 'claude' | 'stub';

const SALT = 'whaser-demo-salt';

export interface StoredAgent {
  id: string;
  tenantId: string;
  ownerUsername: string;
  spec: AgentSpec;
  status: 'live' | 'paused';
  phoneNumberId: string;
  createdAt: number;
  lastActivityAt: number | null;
}

export interface WizardSession {
  id: string;
  ownerUsername: string;
  tenantId: string;
  values: SlotValues;
  finalizeResult?: Awaited<ReturnType<AgentBuilder['finalize']>>;
}

export class AppState {
  /** 'claude' when ANTHROPIC_API_KEY is set, else 'stub'. */
  readonly mode: RuntimeModeName;
  readonly builder: AgentBuilder;
  private readonly agents = new Map<string, StoredAgent>();
  private readonly sessions = new Map<string, WizardSession>();
  private readonly resolver = new InMemoryAgentResolver();
  private readonly conversations = new InMemoryConversationStore();
  private readonly breaker = new CircuitBreaker({ perSenderPerMinute: 20, maxInboundChars: 4000, tenantDailyTokenBudget: 2_000_000 });
  private readonly runtime: WorkflowAgentRuntime;
  private readonly tuner: Tuner;
  private readonly handler: InboundHandler;
  private readonly lastBlock = new Map<string, string>();
  private readonly transcripts = new Map<string, TranscriptTurn[]>();
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
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq.toString(36)}${Math.floor(this.now() % 1000).toString(36)}`;
  }

  private now(): number {
    return Date.now();
  }

  // --- Wizard ---
  startSession(ownerUsername: string, tenantId: string): WizardSession {
    const session: WizardSession = { id: this.id('ws'), ownerUsername, tenantId, values: {} };
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
      phoneNumberId: `SIM-${1000 + this.agents.size}`,
      createdAt: this.now(),
      lastActivityAt: null,
    };
    this.agents.set(agent.id, agent);
    this.resolver.bind(agent.phoneNumberId, { agentId: agent.id, tenantId: agent.tenantId });
    return agent;
  }

  setStatus(id: string, tenantId: string, status: 'live' | 'paused'): StoredAgent | undefined {
    const a = this.getAgent(id, tenantId);
    if (!a) return undefined;
    a.status = status;
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
    // Record a flat per-agent transcript for self-tuning (capped).
    const t = this.transcripts.get(agentId) ?? [];
    t.push({ role: 'user', content: text });
    if (out?.text) t.push({ role: 'assistant', content: out.text });
    this.transcripts.set(agentId, t.slice(-40));
    return { reply: out?.text ?? null, blocked, status: agent.status, routedTo: out ? this.runtime.lastRoutedTo : null };
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
