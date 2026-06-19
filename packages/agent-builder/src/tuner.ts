import type { AgentSpec } from './schema';
import type { AnthropicLike } from './llm';

export type TuningKind = 'add_knowledge' | 'add_in_scope' | 'add_out_of_scope' | 'revise_refusal' | 'revise_greeting';

export interface TuningSuggestion {
  kind: TuningKind;
  rationale: string;
  /** The proposed content: knowledge text, a topic, or replacement greeting/refusal text. */
  value: string;
  /** Short label (used for knowledge sources; '' otherwise). */
  label: string;
}

export interface TuningResult {
  summary: string;
  suggestions: TuningSuggestion[];
}

export interface TranscriptTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Self-improvement seam: review a spec + transcripts and propose AgentSpec edits. Mockable.
 *  `instruction` is optional owner guidance ("make it more formal", "stop answering legal qs"). */
export interface Tuner {
  suggest(args: { spec: AgentSpec; transcripts: TranscriptTurn[]; instruction?: string }): Promise<TuningResult>;
}

/** Structured-output schema for tuning suggestions (closed objects, enum kinds). */
export const TUNING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'suggestions'],
  properties: {
    summary: { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'rationale', 'value', 'label'],
        properties: {
          kind: { type: 'string', enum: ['add_knowledge', 'add_in_scope', 'add_out_of_scope', 'revise_refusal', 'revise_greeting'] },
          rationale: { type: 'string' },
          value: { type: 'string' },
          label: { type: 'string' },
        },
      },
    },
  },
};

/**
 * Apply approved suggestions to a spec, returning a NEW spec with version bumped. Only safe,
 * deterministic edits; keeps in/out-of-scope disjoint and de-dupes, so the result stays
 * consistent. (Callers should still re-validate + consistency-check.)
 */
export function applySuggestions(spec: AgentSpec, suggestions: TuningSuggestion[]): AgentSpec {
  const next: AgentSpec = {
    ...spec,
    version: spec.version + 1,
    in_scope_topics: [...spec.in_scope_topics],
    out_of_scope_topics: [...spec.out_of_scope_topics],
    knowledge_sources: [...spec.knowledge_sources],
  };
  const inLower = new Set(next.in_scope_topics.map((s) => s.toLowerCase()));
  const outLower = new Set(next.out_of_scope_topics.map((s) => s.toLowerCase()));

  for (const s of suggestions) {
    const v = s.value.trim();
    if (!v) continue;
    if (s.kind === 'add_knowledge') {
      next.knowledge_sources.push({ type: 'text', label: s.label.trim() || 'note', content: v });
    } else if (s.kind === 'add_in_scope') {
      if (!inLower.has(v.toLowerCase()) && !outLower.has(v.toLowerCase())) {
        next.in_scope_topics.push(v);
        inLower.add(v.toLowerCase());
      }
    } else if (s.kind === 'add_out_of_scope') {
      if (!outLower.has(v.toLowerCase()) && !inLower.has(v.toLowerCase())) {
        next.out_of_scope_topics.push(v);
        outLower.add(v.toLowerCase());
      }
    } else if (s.kind === 'revise_refusal') {
      next.refusal_policy = v;
    } else if (s.kind === 'revise_greeting') {
      next.greeting = v;
    }
  }
  return next;
}

const TUNER_SYSTEM = [
  'You review a WhatsApp agent\'s AgentSpec and recent conversation transcripts, then propose a few',
  'small, concrete improvements as structured suggestions. Prefer high-value edits: add a knowledge',
  'source for a recurring question; add an out_of_scope topic the agent kept being asked about and',
  'should decline; tighten the refusal or greeting. Each transcript-based suggestion needs a clear',
  'rationale grounded in the transcripts; do not invent transcript evidence. If the owner provides',
  'guidance, PRIORITIZE it — the guidance is itself sufficient justification — and pick the suggestion',
  'kinds that fulfill it (add_knowledge / add_in_scope / add_out_of_scope / revise_refusal /',
  'revise_greeting). Keep in/out-of-scope disjoint.',
].join(' ');

/** Claude-backed tuner (structured output). Inject an AnthropicLike client. */
export class AnthropicTuner implements Tuner {
  private readonly client: AnthropicLike;
  private readonly model: string;

  constructor(opts: { client: AnthropicLike; model?: string }) {
    this.client = opts.client;
    this.model = opts.model ?? 'claude-sonnet-4-6';
  }

  async suggest({ spec, transcripts, instruction }: { spec: AgentSpec; transcripts: TranscriptTurn[]; instruction?: string }): Promise<TuningResult> {
    const guidance = instruction && instruction.trim() ? `\n\nOwner's guidance (prioritize this): ${instruction.trim()}` : '';
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: TUNING_SCHEMA } },
      system: TUNER_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `AgentSpec:\n${JSON.stringify(spec, null, 2)}\n\nRecent transcripts:\n${JSON.stringify(transcripts, null, 2)}${guidance}\n\nPropose improvements.`,
        },
      ],
    });
    if (res.stop_reason === 'refusal') throw new Error('Model refused to propose improvements');
    const text = res.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('Tuner returned no content');
    return JSON.parse(text) as TuningResult;
  }
}
