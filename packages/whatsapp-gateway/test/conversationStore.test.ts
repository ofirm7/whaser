import { describe, it, expect } from 'vitest';
import { InMemoryConversationStore, conversationKey } from '../src/conversationStore';

describe('InMemoryConversationStore', () => {
  it('appends and returns history per key', async () => {
    const s = new InMemoryConversationStore();
    const k = conversationKey('agent_1', 'sender_hash');
    await s.append(k, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' });
    expect(await s.history(k)).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
    expect(await s.history(conversationKey('agent_2', 'sender_hash'))).toEqual([]);
  });

  it('caps history to the most recent maxMessages', async () => {
    const s = new InMemoryConversationStore(2);
    const k = conversationKey('a', 's');
    await s.append(k, { role: 'user', content: '1' });
    await s.append(k, { role: 'assistant', content: '2' });
    await s.append(k, { role: 'user', content: '3' });
    expect(await s.history(k)).toEqual([
      { role: 'assistant', content: '2' },
      { role: 'user', content: '3' },
    ]);
  });
});
