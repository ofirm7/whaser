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
