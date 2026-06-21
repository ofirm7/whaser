import { describe, it, expect } from 'vitest';
import { AnthropicLlmClient } from '../src/llm';
import type { AnthropicLike, AnthropicCreateParams, AnthropicMessage } from '../src/llm';
import { getSlot } from '../src/slots';
import { validSpec } from './fixtures';

function fakeAnthropic(responder: (p: AnthropicCreateParams) => AnthropicMessage) {
  const calls: AnthropicCreateParams[] = [];
  const client: AnthropicLike = {
    messages: {
      async create(params: AnthropicCreateParams) {
        calls.push(params);
        return responder(params);
      },
    },
  };
  return { client, calls };
}

describe('AnthropicLlmClient.extractSlot', () => {
  it('forces strict tool use and parses a text value', async () => {
    const { client, calls } = fakeAnthropic(() => ({
      content: [{ type: 'tool_use', name: 'record_slot', input: { value: 'Acme Support' } }],
    }));
    const llm = new AnthropicLlmClient({ client });
    const value = await llm.extractSlot({ slot: getSlot('agent_name'), userText: 'call it Acme Support' });
    expect(value).toBe('Acme Support');
    expect(calls[0].model).toBe('claude-sonnet-4-6');
    expect(calls[0].tool_choice).toEqual({ type: 'tool', name: 'record_slot' });
  });

  it('parses a list value for list slots', async () => {
    const { client } = fakeAnthropic(() => ({
      content: [{ type: 'tool_use', name: 'record_slot', input: { value: ['pricing', 'features'] } }],
    }));
    const llm = new AnthropicLlmClient({ client });
    const value = await llm.extractSlot({ slot: getSlot('in_scope_topics'), userText: 'pricing and features' });
    expect(value).toEqual(['pricing', 'features']);
  });

  it('returns [] for a list slot when the model returns no array', async () => {
    const { client } = fakeAnthropic(() => ({ content: [{ type: 'tool_use', input: {} }] }));
    const llm = new AnthropicLlmClient({ client });
    expect(await llm.extractSlot({ slot: getSlot('tools'), userText: 'none' })).toEqual([]);
  });

  it('throws on a refusal', async () => {
    const { client } = fakeAnthropic(() => ({ content: [], stop_reason: 'refusal' }));
    const llm = new AnthropicLlmClient({ client });
    await expect(llm.extractSlot({ slot: getSlot('goal'), userText: 'x' })).rejects.toThrow(/refus/i);
  });
});

describe('AnthropicLlmClient.synthesizeSpec', () => {
  it('uses structured output + adaptive thinking and parses the JSON', async () => {
    const { client, calls } = fakeAnthropic(() => ({
      content: [{ type: 'text', text: JSON.stringify(validSpec) }],
    }));
    const llm = new AnthropicLlmClient({ client });
    const spec = await llm.synthesizeSpec({ values: { agent_name: 'Acme' } });
    expect(spec).toEqual(validSpec);
    expect(calls[0].model).toBe('claude-opus-4-8');
    expect(calls[0].thinking).toEqual({ type: 'adaptive' });
    expect((calls[0].output_config?.format as { type: string }).type).toBe('json_schema');
  });

  it('throws on a refusal', async () => {
    const { client } = fakeAnthropic(() => ({ content: [], stop_reason: 'refusal' }));
    const llm = new AnthropicLlmClient({ client });
    await expect(llm.synthesizeSpec({ values: {} })).rejects.toThrow(/refus/i);
  });
});

describe('AnthropicLlmClient.interview', () => {
  it('forces the respond tool and returns reply + readiness', async () => {
    const { client, calls } = fakeAnthropic(() => ({
      content: [{ type: 'tool_use', name: 'respond', input: { reply: 'What should it do?', ready_to_build: false } }],
    }));
    const llm = new AnthropicLlmClient({ client });
    const r = await llm.interview({ messages: [{ role: 'user', content: 'a support bot' }] });
    expect(r).toEqual({ reply: 'What should it do?', readyToBuild: false });
    expect(calls[0].tool_choice).toEqual({ type: 'tool', name: 'respond' });
    expect(calls[0].messages).toEqual([{ role: 'user', content: 'a support bot' }]);
  });

  it('passes ready_to_build=true through', async () => {
    const { client } = fakeAnthropic(() => ({
      content: [{ type: 'tool_use', name: 'respond', input: { reply: 'Ready!', ready_to_build: true } }],
    }));
    const llm = new AnthropicLlmClient({ client });
    expect(await llm.interview({ messages: [{ role: 'user', content: 'go' }] })).toEqual({ reply: 'Ready!', readyToBuild: true });
  });

  it('throws on a refusal', async () => {
    const { client } = fakeAnthropic(() => ({ content: [], stop_reason: 'refusal' }));
    const llm = new AnthropicLlmClient({ client });
    await expect(llm.interview({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/refus|interview/i);
  });
});

describe('AnthropicLlmClient.synthesizeFromConversation', () => {
  it('uses structured output over the transcript and parses the JSON', async () => {
    const { client, calls } = fakeAnthropic(() => ({
      content: [{ type: 'text', text: JSON.stringify(validSpec) }],
    }));
    const llm = new AnthropicLlmClient({ client });
    const spec = await llm.synthesizeFromConversation({
      messages: [
        { role: 'user', content: 'a pre-sales bot' },
        { role: 'assistant', content: 'what tools?' },
        { role: 'user', content: 'web search' },
      ],
    });
    expect(spec).toEqual(validSpec);
    expect(calls[0].model).toBe('claude-opus-4-8');
    expect((calls[0].output_config?.format as { type: string }).type).toBe('json_schema');
    // The whole transcript reaches the model.
    expect(String((calls[0].messages[0] as { content: string }).content)).toContain('web search');
  });
});
