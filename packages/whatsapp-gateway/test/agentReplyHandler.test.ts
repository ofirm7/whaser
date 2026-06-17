import { describe, it, expect } from 'vitest';
import { createAgentReplyHandler } from '../src/agentReplyHandler';
import { InMemoryAgentResolver } from '../src/agentResolver';
import { InMemoryConversationStore } from '../src/conversationStore';
import { CircuitBreaker } from '../src/circuitBreaker';
import type { AgentRuntime, RuntimeMessage } from '../src/agentRuntime';
import type { InboundMessage } from '../src/types';

const msg = (text: string, opts: Partial<InboundMessage> = {}): InboundMessage => ({
  waMessageId: opts.waMessageId ?? 'wamid.1',
  from: opts.from ?? '15551230000',
  phoneNumberId: opts.phoneNumberId ?? 'PN1',
  type: opts.type ?? 'text',
  text,
  timestamp: 1,
});

function recordingRuntime(reply = 'hello from agent', usage = { inputTokens: 10, outputTokens: 5 }) {
  const calls: Array<{ agentId: string; messages: RuntimeMessage[] }> = [];
  const runtime: AgentRuntime = {
    async complete({ agentId, messages }) {
      calls.push({ agentId, messages });
      return { text: reply, usage, finishReason: 'stop' };
    },
  };
  return { runtime, calls };
}

const deps = () => ({
  resolver: new InMemoryAgentResolver({ PN1: { agentId: 'agent_1', tenantId: 'tenant_a' } }),
  conversations: new InMemoryConversationStore(),
  breaker: new CircuitBreaker({ perSenderPerMinute: 5, maxInboundChars: 1000, tenantDailyTokenBudget: 1000 }),
  hashSalt: 'salt',
});

describe('createAgentReplyHandler', () => {
  it('resolves the agent, replies, records spend, and persists the turn', async () => {
    const d = deps();
    const { runtime, calls } = recordingRuntime();
    const handler = createAgentReplyHandler({ ...d, runtime });

    const out = await handler(msg('hi'));
    expect(out).toEqual({ to: '15551230000', text: 'hello from agent' });
    expect(calls[0].agentId).toBe('agent_1');
    expect(calls[0].messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(d.breaker.usage('tenant_a')).toBe(15);
  });

  it('replays stored history on the next turn from the same sender', async () => {
    const d = deps();
    const { runtime, calls } = recordingRuntime('reply');
    const handler = createAgentReplyHandler({ ...d, runtime });

    await handler(msg('first', { waMessageId: 'm1' }));
    await handler(msg('second', { waMessageId: 'm2' }));

    expect(calls[1].messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ]);
  });

  it('returns null for an unrouted number (no runtime call)', async () => {
    const d = deps();
    const { runtime, calls } = recordingRuntime();
    const handler = createAgentReplyHandler({ ...d, runtime });
    const out = await handler(msg('hi', { phoneNumberId: 'UNKNOWN' }));
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null and skips the model when the breaker blocks (budget)', async () => {
    const d = deps();
    d.breaker.record('tenant_a', 1000); // exhaust budget
    const { runtime, calls } = recordingRuntime();
    const reasons: string[] = [];
    const handler = createAgentReplyHandler({ ...d, runtime, onBlocked: (r) => reasons.push(r) });
    const out = await handler(msg('hi'));
    expect(out).toBeNull();
    expect(calls).toHaveLength(0);
    expect(reasons).toEqual(['tenant_budget_exceeded']);
  });

  it('ignores non-text messages', async () => {
    const d = deps();
    const { runtime, calls } = recordingRuntime();
    const handler = createAgentReplyHandler({ ...d, runtime });
    expect(await handler(msg('', { type: 'image' }))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('propagates runtime errors so the worker can retry', async () => {
    const d = deps();
    const runtime: AgentRuntime = {
      async complete() {
        throw new Error('upstream 500');
      },
    };
    const handler = createAgentReplyHandler({ ...d, runtime });
    await expect(handler(msg('hi'))).rejects.toThrow(/upstream 500/);
  });

  it('returns null when the agent produces empty text', async () => {
    const d = deps();
    const { runtime } = recordingRuntime('');
    const handler = createAgentReplyHandler({ ...d, runtime });
    expect(await handler(msg('hi'))).toBeNull();
  });
});
