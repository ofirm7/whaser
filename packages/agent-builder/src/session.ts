import type { SlotId, SlotSpec, SlotValue, SlotValues } from './slots';
import { getSlot, nextMissingSlot, validateSlotValue } from './slots';

export const GREETING =
  "Let's design your WhatsApp agent. I'll ask a few questions, then assemble a precise spec you can review.";

/** A confirmation read-back once every slot is answered. */
export function summarize(values: SlotValues): string {
  const lines = Object.entries(values).map(([id, v]) => {
    const shown = Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : v;
    return `- ${id}: ${shown}`;
  });
  return `Here's what I have:\n${lines.join('\n')}\n\nShall I build the agent from this?`;
}

/** The next thing to show the user: a slot question, or the confirmation read-back. */
export function nextPrompt(values: SlotValues): { kind: 'ask'; slot: SlotSpec } | { kind: 'confirm'; text: string } {
  const slot = nextMissingSlot(values);
  if (slot) return { kind: 'ask', slot };
  return { kind: 'confirm', text: summarize(values) };
}

/**
 * Merge a validated answer for a slot. Throws on validation failure so the caller re-asks.
 * Pure — returns a new values object.
 */
export function submitAnswer(values: SlotValues, slotId: SlotId, value: SlotValue): SlotValues {
  const spec = getSlot(slotId);
  const v = validateSlotValue(spec, value);
  if (!v.ok) throw new Error(v.error ?? `Invalid value for ${slotId}`);
  return { ...values, [slotId]: value };
}
