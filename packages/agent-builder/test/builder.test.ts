import { describe, it, expect } from 'vitest';
import { AgentBuilder } from '../src/builder';
import type { LlmClient } from '../src/llm';
import type { SlotSpec, SlotValue, SlotValues } from '../src/slots';
import { SLOTS } from '../src/slots';
import { validSpec } from './fixtures';

/** Mock LLM: extract echoes text, splits lists on commas; synth returns a preset object. */
class MockLlm implements LlmClient {
  constructor(private readonly specToReturn: unknown) {}
  async extractSlot({ slot, userText }: { slot: SlotSpec; userText: string }): Promise<SlotValue> {
    if (slot.kind === 'list') return userText.split(',').map((s) => s.trim()).filter(Boolean);
    return userText;
  }
  async synthesizeSpec(): Promise<unknown> {
    return this.specToReturn;
  }
}

async function runInterview(builder: AgentBuilder, answers: Record<string, string>): Promise<SlotValues> {
  let values: SlotValues = {};
  for (const slot of SLOTS) {
    const r = await builder.submitText(values, answers[slot.id] ?? '');
    values = r.values;
  }
  return values;
}

const ANSWERS: Record<string, string> = {
  agent_name: 'Acme Support',
  audience: 'prospective customers',
  goal: 'answer pre-sales questions',
  tone: 'friendly',
  in_scope_topics: 'pricing, features',
  out_of_scope_topics: 'legal advice',
  escalation: 'hand off when asked for a human',
  tools: 'lookup_plan',
  knowledge_sources: '',
  default_language: 'English',
};

describe('AgentBuilder', () => {
  it('drives the interview, then confirms when complete', async () => {
    const b = new AgentBuilder(new MockLlm(validSpec));
    expect(b.start().prompt.kind).toBe('ask');

    let values: SlotValues = {};
    let lastComplete = false;
    let lastKind = '';
    for (const slot of SLOTS) {
      const r = await b.submitText(values, ANSWERS[slot.id]);
      values = r.values;
      lastComplete = r.complete;
      lastKind = r.prompt.kind;
    }
    expect(lastComplete).toBe(true);
    expect(lastKind).toBe('confirm');
    expect(values.in_scope_topics).toEqual(['pricing', 'features']);
    expect(values.knowledge_sources).toEqual([]); // "none" -> empty list
  });

  it('finalizes a valid, consistent spec as publishable', async () => {
    const b = new AgentBuilder(new MockLlm(validSpec), { knownExecutors: ['lookup_plan'] });
    const values = await runInterview(b, ANSWERS);
    const out = await b.finalize(values);
    expect(out.valid).toBe(true);
    expect(out.issues).toEqual([]);
    expect(out.publishable).toBe(true);
  });

  it('reports consistency issues for a schema-valid but inconsistent spec', async () => {
    const inconsistent = { ...validSpec, out_of_scope_topics: ['pricing'] };
    const b = new AgentBuilder(new MockLlm(inconsistent));
    const out = await b.finalize({});
    expect(out.valid).toBe(true);
    expect(out.issues.map((i) => i.code)).toContain('scope_overlap');
    expect(out.publishable).toBe(false);
  });

  it('reports schema errors and is not publishable for an invalid spec', async () => {
    const b = new AgentBuilder(new MockLlm({ not: 'an agent spec' }));
    const out = await b.finalize({});
    expect(out.valid).toBe(false);
    expect(out.schemaErrors.length).toBeGreaterThan(0);
    expect(out.publishable).toBe(false);
  });
});
