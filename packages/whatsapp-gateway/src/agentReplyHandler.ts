import type { InboundHandler, InboundMessage } from './types';
import type { AgentResolver } from './agentResolver';
import type { AgentRuntime } from './agentRuntime';
import type { ConversationStore } from './conversationStore';
import type { CircuitBreaker } from './circuitBreaker';
import { conversationKey } from './conversationStore';
import { hashSender } from './senderHash';

export interface AgentReplyHandlerOptions {
  resolver: AgentResolver;
  runtime: AgentRuntime;
  conversations: ConversationStore;
  breaker: CircuitBreaker;
  hashSalt: string;
  onBlocked?: (reason: string, msg: InboundMessage) => void;
}

/**
 * Phase-3 reply handler — the production replacement for `echoHandler`. For each inbound text:
 *   resolve phone_number_id → agent  →  cost/abuse gate  →  run the agent over stored history
 *   →  record spend  →  persist the turn  →  reply.
 *
 * Returns null (no reply, job completes) when unrouted, blocked, or the reply is empty.
 * Throws on runtime/network errors so the worker retries (idempotent send guards double-reply).
 */
export function createAgentReplyHandler(opts: AgentReplyHandlerOptions): InboundHandler {
  return async (msg) => {
    if (msg.type !== 'text' || !msg.text) return null;

    const route = await opts.resolver.resolve(msg.phoneNumberId);
    if (!route) {
      opts.onBlocked?.('no_agent_for_number', msg);
      return null;
    }

    const senderHash = hashSender(msg.from, opts.hashSalt);
    const decision = opts.breaker.allow({
      senderHash,
      tenantId: route.tenantId,
      textLength: msg.text.length,
    });
    if (!decision.allowed) {
      opts.onBlocked?.(decision.reason ?? 'blocked', msg);
      return null;
    }

    const key = conversationKey(route.agentId, senderHash);
    const history = await opts.conversations.history(key);
    const userMessage = { role: 'user' as const, content: msg.text };

    const reply = await opts.runtime.complete({
      agentId: route.agentId,
      messages: [...history, userMessage],
      currentTurnMedia: msg.currentTurnMedia,
    });

    opts.breaker.record(route.tenantId, reply.usage.inputTokens + reply.usage.outputTokens);
    // Always remember the user turn; only record the assistant turn when it actually said something —
    // a blank assistant message would otherwise pollute the history that later turns (and seeding) replay.
    if (reply.text) {
      await opts.conversations.append(key, userMessage, { role: 'assistant', content: reply.text });
      return { to: msg.from, text: reply.text };
    }
    await opts.conversations.append(key, userMessage);
    return null;
  };
}
