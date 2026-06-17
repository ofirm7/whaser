import { AgentBuilder, AnthropicLlmClient } from '../../../packages/agent-builder/src/index';
import type { AgentSpec, SlotValues } from '../../../packages/agent-builder/src/index';
import { InMemoryAgentResolver } from '../../../packages/whatsapp-gateway/src/agentResolver';
import { InMemoryConversationStore, conversationKey } from '../../../packages/whatsapp-gateway/src/conversationStore';
import { CircuitBreaker } from '../../../packages/whatsapp-gateway/src/circuitBreaker';
import { createAgentReplyHandler } from '../../../packages/whatsapp-gateway/src/agentReplyHandler';
import { hashSender } from '../../../packages/whatsapp-gateway/src/senderHash';
import type { InboundHandler, InboundMessage } from '../../../packages/whatsapp-gateway/src/types';
import type { AgentRuntime, RuntimeMessage } from '../../../packages/whatsapp-gateway/src/agentRuntime';
import { StubLlmClient, StubAgentRuntime } from './stubs';
import { makeAnthropicLike, AnthropicAgentRuntime } from './anthropic';

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
  private readonly runtime: AgentRuntime;
  private readonly handler: InboundHandler;
  private readonly lastBlock = new Map<string, string>();
  private seq = 0;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const getSpec = (agentId: string): AgentSpec | undefined => this.agents.get(agentId)?.spec;
    if (apiKey) {
      this.mode = 'claude';
      this.builder = new AgentBuilder(new AnthropicLlmClient({ client: makeAnthropicLike(apiKey) }));
      this.runtime = new AnthropicAgentRuntime(apiKey, getSpec);
    } else {
      this.mode = 'stub';
      this.builder = new AgentBuilder(new StubLlmClient());
      this.runtime = new StubAgentRuntime(getSpec);
    }
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
  async simulateInbound(agentId: string, tenantId: string, from: string, text: string): Promise<{ reply: string | null; blocked: string | null; status: string } | null> {
    const agent = this.getAgent(agentId, tenantId);
    if (!agent) return null;
    if (agent.status !== 'live') return { reply: null, blocked: 'agent_paused', status: agent.status };
    const waMessageId = `sim-${++this.seq}`;
    const msg: InboundMessage = { waMessageId, from, phoneNumberId: agent.phoneNumberId, type: 'text', text, timestamp: this.now() };
    const out = await this.handler(msg);
    agent.lastActivityAt = this.now();
    return { reply: out?.text ?? null, blocked: this.lastBlock.get(waMessageId) ?? null, status: agent.status };
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
