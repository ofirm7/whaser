import type { LlmClient, InterviewTurn, TriggerPlan } from './llm';
import type { SlotValues } from './slots';
import type { AgentSpec } from './schema';
import type { ConsistencyIssue } from './consistency';
import type { SchemaValidation } from './validate';
import { nextMissingSlot, isComplete } from './slots';
import { GREETING, INTERVIEW_GREETING, nextPrompt, submitAnswer } from './session';
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
    return this.check(await this.llm.synthesizeSpec({ values }));
  }

  // --- Conversational builder (free-form interview; replaces the fixed slot questionnaire) ---

  /** Opening message that invites the user to describe the agent in their own words. */
  startInterview(): { greeting: string } {
    return { greeting: INTERVIEW_GREETING };
  }

  /** One interviewer turn: the assistant's next message, whether it has enough to build, and whether
   *  the user just asked to build now (so the UI can start the build without a button click). */
  async interview(messages: InterviewTurn[]): Promise<{ reply: string; readyToBuild: boolean; buildNow: boolean }> {
    return this.llm.interview({ messages });
  }

  /** Synthesize the AgentSpec from the whole interview transcript, then validate + consistency-check. */
  async finalizeInterview(messages: InterviewTurn[]): Promise<FinalizeResult> {
    return this.check(await this.llm.synthesizeFromConversation({ messages }));
  }

  // --- Timed-action (trigger) builder for an existing agent ---

  /** One interviewer turn while designing a timed action for an existing agent. */
  async interviewTrigger(spec: AgentSpec, messages: InterviewTurn[]): Promise<{ reply: string; readyToBuild: boolean; buildNow: boolean }> {
    return this.llm.interviewTrigger({ spec, messages });
  }

  /** Synthesize the timed-action plan (label, action prompt, cadence, capability requests). */
  async synthesizeTrigger(spec: AgentSpec, messages: InterviewTurn[]): Promise<TriggerPlan> {
    return this.llm.synthesizeTrigger({ spec, messages });
  }

  /** Validate + consistency-check a synthesized spec into a FinalizeResult. */
  private check(spec: unknown): FinalizeResult {
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
