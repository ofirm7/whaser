import type { RuntimeMessage } from './agentRuntime';

/**
 * Per-(agent, sender) conversation history. Whaser owns this state and replays it to the
 * runtime each turn (the runtime is stateless from our perspective — see agentRuntime.ts).
 */
export interface ConversationStore {
  history(key: string): Promise<RuntimeMessage[]>;
  append(key: string, ...messages: RuntimeMessage[]): Promise<void>;
}

/** Stable key for a conversation thread. */
export function conversationKey(agentId: string, senderHash: string): string {
  return `${agentId}:${senderHash}`;
}

/**
 * In-memory store for dev/test, capped to the most recent `maxMessages` to bound token cost
 * within the 24h service window. Production uses the `waConversations`/`messages` collections.
 */
export class InMemoryConversationStore implements ConversationStore {
  private readonly store = new Map<string, RuntimeMessage[]>();

  constructor(private readonly maxMessages = 20) {}

  async history(key: string): Promise<RuntimeMessage[]> {
    return this.store.get(key) ?? [];
  }

  async append(key: string, ...messages: RuntimeMessage[]): Promise<void> {
    const next = [...(this.store.get(key) ?? []), ...messages];
    this.store.set(key, next.slice(-this.maxMessages));
  }
}
