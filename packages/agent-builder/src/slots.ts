export type SlotId =
  | 'agent_name'
  | 'audience'
  | 'goal'
  | 'tone'
  | 'in_scope_topics'
  | 'out_of_scope_topics'
  | 'escalation'
  | 'tools'
  | 'knowledge_sources'
  | 'default_language';

export type SlotKind = 'text' | 'list';

export interface SlotSpec {
  id: SlotId;
  question: string;
  kind: SlotKind;
}

export type SlotValue = string | string[];
export type SlotValues = Partial<Record<SlotId, SlotValue>>;

/**
 * The interview, in order. Every slot is asked once; `list` slots accept an empty list
 * (the user can answer "none"), so completeness = every slot has been answered.
 */
export const SLOTS: readonly SlotSpec[] = [
  { id: 'agent_name', kind: 'text', question: 'What should this agent be called?' },
  { id: 'audience', kind: 'text', question: 'Who will be messaging this agent?' },
  { id: 'goal', kind: 'text', question: "What's the single main thing it should accomplish?" },
  { id: 'tone', kind: 'text', question: 'What tone/personality should it have (e.g. friendly, formal, concise)?' },
  { id: 'in_scope_topics', kind: 'list', question: 'Which topics SHOULD it handle?' },
  { id: 'out_of_scope_topics', kind: 'list', question: 'Which topics should it decline or stay away from?' },
  { id: 'escalation', kind: 'text', question: 'When should it hand off to a human, and how?' },
  { id: 'tools', kind: 'list', question: 'What actions or lookups should it perform, if any? (or "none")' },
  { id: 'knowledge_sources', kind: 'list', question: 'Any reference info it should know — FAQ text or links? (or "none")' },
  { id: 'default_language', kind: 'text', question: 'What default language should it use? (e.g. English)' },
];

const SLOT_BY_ID = new Map<SlotId, SlotSpec>(SLOTS.map((s) => [s.id, s]));

export function getSlot(id: SlotId): SlotSpec {
  const s = SLOT_BY_ID.get(id);
  if (!s) throw new Error(`Unknown slot: ${id}`);
  return s;
}

/** First slot (in interview order) that has no value yet, or null when complete. */
export function nextMissingSlot(values: SlotValues): SlotSpec | null {
  return SLOTS.find((s) => values[s.id] === undefined) ?? null;
}

export function isComplete(values: SlotValues): boolean {
  return nextMissingSlot(values) === null;
}

export interface SlotValidation {
  ok: boolean;
  error?: string;
}

/** Validate a candidate value for a slot. Text must be non-empty; lists may be empty ("none"). */
export function validateSlotValue(spec: SlotSpec, value: SlotValue): SlotValidation {
  if (spec.kind === 'list') {
    if (!Array.isArray(value)) return { ok: false, error: `${spec.id} must be a list` };
    return { ok: true };
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: `${spec.id} must be a non-empty answer` };
  }
  return { ok: true };
}
