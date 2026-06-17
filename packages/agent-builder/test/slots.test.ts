import { describe, it, expect } from 'vitest';
import { SLOTS, nextMissingSlot, isComplete, validateSlotValue, getSlot } from '../src/slots';
import type { SlotValues } from '../src/slots';

describe('slots', () => {
  it('asks slots in declared order', () => {
    expect(nextMissingSlot({})?.id).toBe('agent_name');
    const partial: SlotValues = { agent_name: 'X', audience: 'Y' };
    expect(nextMissingSlot(partial)?.id).toBe('goal');
  });

  it('isComplete only when every slot has a value (empty lists count)', () => {
    const values: SlotValues = {};
    for (const s of SLOTS) values[s.id] = s.kind === 'list' ? [] : 'x';
    expect(isComplete(values)).toBe(true);
    delete values.default_language;
    expect(isComplete(values)).toBe(false);
  });

  it('validates text (non-empty) and list (array, empty allowed)', () => {
    expect(validateSlotValue(getSlot('goal'), 'do things').ok).toBe(true);
    expect(validateSlotValue(getSlot('goal'), '   ').ok).toBe(false);
    expect(validateSlotValue(getSlot('tools'), []).ok).toBe(true);
    expect(validateSlotValue(getSlot('tools'), ['a']).ok).toBe(true);
    expect(validateSlotValue(getSlot('tools'), 'not a list' as unknown as string[]).ok).toBe(false);
  });
});
