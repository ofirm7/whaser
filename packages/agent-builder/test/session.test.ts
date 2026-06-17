import { describe, it, expect } from 'vitest';
import { submitAnswer, nextPrompt, summarize } from '../src/session';
import { SLOTS } from '../src/slots';
import type { SlotValues } from '../src/slots';

describe('session', () => {
  it('submitAnswer merges valid values and rejects invalid ones', () => {
    const v = submitAnswer({}, 'agent_name', 'Acme');
    expect(v.agent_name).toBe('Acme');
    expect(() => submitAnswer({}, 'goal', '  ')).toThrow();
  });

  it('nextPrompt asks until complete, then confirms', () => {
    expect(nextPrompt({}).kind).toBe('ask');
    const full: SlotValues = {};
    for (const s of SLOTS) full[s.id] = s.kind === 'list' ? [] : 'x';
    const p = nextPrompt(full);
    expect(p.kind).toBe('confirm');
    if (p.kind === 'confirm') expect(p.text).toContain('build the agent');
  });

  it('summarize renders list and text values', () => {
    const s = summarize({ agent_name: 'Acme', in_scope_topics: ['pricing'], tools: [] });
    expect(s).toContain('agent_name: Acme');
    expect(s).toContain('pricing');
    expect(s).toContain('(none)');
  });
});
