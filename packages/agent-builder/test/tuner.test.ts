import { describe, it, expect } from 'vitest';
import { applySuggestions } from '../src/tuner';
import type { TuningSuggestion } from '../src/tuner';
import { validateAgentSpec } from '../src/validate';
import { checkConsistency } from '../src/consistency';
import { validSpec } from './fixtures';

describe('applySuggestions', () => {
  it('bumps the version and applies safe edits', () => {
    const s: TuningSuggestion[] = [
      { kind: 'add_knowledge', label: 'Returns', value: 'Returns accepted within 30 days.', rationale: 'asked often' },
      { kind: 'add_out_of_scope', label: '', value: 'refunds', rationale: 'repeatedly asked, should decline' },
      { kind: 'revise_greeting', label: '', value: 'Hey! Acme here — how can I help?', rationale: 'warmer' },
    ];
    const next = applySuggestions(validSpec, s);
    expect(next.version).toBe(validSpec.version + 1);
    expect(next.knowledge_sources.some((k) => k.content.includes('30 days'))).toBe(true);
    expect(next.out_of_scope_topics).toContain('refunds');
    expect(next.greeting).toContain('Acme here');
    // original is untouched
    expect(validSpec.out_of_scope_topics).not.toContain('refunds');
  });

  it('keeps in/out-of-scope disjoint (does not add an in-scope topic to out-of-scope)', () => {
    const next = applySuggestions(validSpec, [{ kind: 'add_out_of_scope', label: '', value: 'pricing', rationale: 'x' }]);
    expect(next.out_of_scope_topics).not.toContain('pricing'); // 'pricing' is in-scope
  });

  it('produces a spec that still passes schema + consistency checks', () => {
    const next = applySuggestions(validSpec, [
      { kind: 'add_knowledge', label: 'Hours', value: 'Open 9-5.', rationale: 'common' },
      { kind: 'add_in_scope', label: '', value: 'integrations', rationale: 'asked' },
    ]);
    expect(validateAgentSpec(next).valid).toBe(true);
    expect(checkConsistency(next)).toEqual([]);
  });
});
