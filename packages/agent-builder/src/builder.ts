import type { LlmClient } from './llm';
import type { SlotValues } from './slots';
import type { AgentSpec } from './schema';
import type { ConsistencyIssue } from './consistency';
import type { SchemaValidation } from './validate';
import { nextMissingSlot, isComplete } from './slots';
import { GREETING, nextPrompt, submitAnswer } from './session';
import { validateAgentSpec } from './validate';
import { checkConsistency } from './consistency';

export interface TurnResult {
  values: SlotValues;
  /** What to show the user next: ask another slot, or confirm and finalize. */
  prompt: ReturnType<typeof nextPrompt>;
  complete: boolean;
}

export interface FinalizeResult {
  spec: unknown;
  valid: boolean;
  schemaErrors: string[];
  /** Empty only when valid and consistent — i.e. ready to publish. */
  issues: ConsistencyIssue[];
  publishable: boolean;
}

/**
 * Orchestrates the conversational wizard: drives the slot interview via the LLM extractor, then
 * synthesizes + validates + consistency-checks the AgentSpec. Pure of any transport/UI; the GUI
 * (and the WhatsApp sandbox preview) call these methods.
 */
export class AgentBuilder {
  constructor(
    private readonly llm: LlmClient,
    private readonly opts: { knownExecutors?: string[] } = {},
  ) {}

  /** Opening message + the first question. */
  start(): { greeting: string; prompt: ReturnType<typeof nextPrompt> } {
    return { greeting: GREETING, prompt: nextPrompt({}) };
  }

  /** Process one free-text user answer: extract it into the current slot and advance. */
  async submitText(values: SlotValues, userText: string): Promise<TurnResult> {
    const slot = nextMissingSlot(values);
    if (!slot) {
      return { values, prompt: nextPrompt(values), complete: true };
    }
    const extracted = await this.llm.extractSlot({ slot, userText });
    const next = submitAnswer(values, slot.id, extracted);
    return { values: next, prompt: nextPrompt(next), complete: isComplete(next) };
  }

  /** Synthesize the AgentSpec from collected answers and run schema + consistency checks. */
  async finalize(values: SlotValues): Promise<FinalizeResult> {
    const spec = await this.llm.synthesizeSpec({ values });
    const schema: SchemaValidation = validateAgentSpec(spec);
    const issues = schema.valid ? checkConsistency(spec as AgentSpec, this.opts) : [];
    return {
      spec,
      valid: schema.valid,
      schemaErrors: schema.errors,
      issues,
      publishable: schema.valid && issues.length === 0,
    };
  }
}
