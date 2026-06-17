import { describe, it, expect } from 'vitest';
import { LibreChatAgentClient } from '../src/agentRuntime';

function mockFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('LibreChatAgentClient', () => {
  it('POSTs the OpenAI-compatible request and parses content + usage', async () => {
    const { fetchImpl, calls } = mockFetch(200, {
      choices: [{ message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    });
    const client = new LibreChatAgentClient({ baseUrl: 'http://api:3080/', apiKey: 'lc-key', fetchImpl });

    const reply = await client.complete({ agentId: 'agent_1', messages: [{ role: 'user', content: 'hi' }] });

    expect(reply.text).toBe('hi there');
    expect(reply.usage).toEqual({ inputTokens: 12, outputTokens: 3 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://api:3080/api/agents/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer lc-key');
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent).toMatchObject({ model: 'agent_1', stream: false, messages: [{ role: 'user', content: 'hi' }] });
    expect('conversation_id' in sent).toBe(false);
  });

  it('forwards conversation_id when provided', async () => {
    const { fetchImpl, calls } = mockFetch(200, { choices: [{ message: { content: 'ok' } }], usage: {} });
    const client = new LibreChatAgentClient({ baseUrl: 'http://api:3080', apiKey: 'k', fetchImpl });
    await client.complete({ agentId: 'a', messages: [{ role: 'user', content: 'x' }], conversationId: 'conv-9' });
    expect(JSON.parse(calls[0].init.body as string).conversation_id).toBe('conv-9');
  });

  it('handles a null content reply as empty text', async () => {
    const { fetchImpl } = mockFetch(200, { choices: [{ message: { content: null } }], usage: {} });
    const client = new LibreChatAgentClient({ baseUrl: 'http://api:3080', apiKey: 'k', fetchImpl });
    const reply = await client.complete({ agentId: 'a', messages: [] });
    expect(reply.text).toBe('');
    expect(reply.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('throws on a non-2xx response', async () => {
    const { fetchImpl } = mockFetch(401, { error: 'unauthorized' });
    const client = new LibreChatAgentClient({ baseUrl: 'http://api:3080', apiKey: 'bad', fetchImpl });
    await expect(client.complete({ agentId: 'a', messages: [] })).rejects.toThrow(/401/);
  });
});
