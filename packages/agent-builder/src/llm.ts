import type { SlotSpec, SlotValue, SlotValues } from './slots';
import { AGENT_SPEC_SCHEMA } from './schema';

/**
 * What the wizard needs from an LLM. Implemented against Anthropic Claude below; a fake is
 * trivial to provide in tests (and the `@anthropic-ai/sdk` runtime fallback could implement it).
 */
export interface LlmClient {
  /** Extract a typed value for one slot from the user's free-text answer (strict tool use). */
  extractSlot(args: { slot: SlotSpec; userText: string }): Promise<SlotValue>;
  /** Synthesize a full AgentSpec object from the collected slot values (structured output). */
  synthesizeSpec(args: { values: SlotValues }): Promise<unknown>;
}

// --- Minimal Anthropic Messages surface (so the SDK can be injected/cast, and faked in tests) ---

export interface AnthropicCreateParams {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  system?: string;
  tools?: unknown[];
  tool_choice?: unknown;
  thinking?: { type: 'adaptive' };
  output_config?: { format?: unknown; effort?: string };
}

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface AnthropicMessage {
  content: AnthropicContentBlock[];
  stop_reason?: string;
}

export interface AnthropicLike {
  messages: { create(params: AnthropicCreateParams): Promise<AnthropicMessage> };
}

export interface AnthropicModels {
  /** Slot extraction + routine work. */
  extract: string;
  /** AgentSpec synthesis (harder reasoning). */
  synthesize: string;
}

export const DEFAULT_MODELS: AnthropicModels = {
  extract: 'claude-sonnet-4-6',
  synthesize: 'claude-opus-4-8',
};

const SYNTH_SYSTEM = [
  'You convert a set of interview answers into a single valid Whaser AgentSpec JSON object.',
  'Derive refusal_policy, greeting, and fallback_message from the persona, goal, and scope.',
  'in_scope_topics and out_of_scope_topics MUST be disjoint.',
  'For each action the user described, emit a tools[] entry with a clear name, a prescriptive',
  '"call this when..." description, a closed parameters[] list (each {name,type,description,required}),',
  'and side_effecting=true only if it writes or calls an external system.',
  'WORKFLOW–AGENT–TOOL: if the agent spans distinct task areas, set workflow.mode="router" with one',
  'route per area (intent + when-it-applies description + target) and a matching sub_agents[] entry',
  '(id, name, specialty, tool_names drawn from tools[]); otherwise workflow.mode="single" with empty',
  'routes and empty sub_agents. Always include both sub_agents and workflow. Set on_no_match="default"',
  'so greetings and unmatched messages go to the default agent (it still declines out-of-scope via',
  'refusal_policy); use "handoff" only if every unmatched message must escalate to a human. version=1.',
  'needs_sandbox=true only if any tool is',
  'side_effecting. model_assignment defaults to claude-sonnet-4-6; use claude-opus-4-8 only if the goal',
  'needs hard reasoning.',
].join(' ');

/** Drives Anthropic Claude. Inject a real SDK instance (cast to AnthropicLike) or a fake. */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: AnthropicLike;
  private readonly models: AnthropicModels;

  constructor(opts: { client: AnthropicLike; models?: AnthropicModels }) {
    this.client = opts.client;
    this.models = opts.models ?? DEFAULT_MODELS;
  }

  async extractSlot({ slot, userText }: { slot: SlotSpec; userText: string }): Promise<SlotValue> {
    const isList = slot.kind === 'list';
    const valueSchema = isList ? { type: 'array', items: { type: 'string' } } : { type: 'string' };
    const tool = {
      name: 'record_slot',
      description: `Record the user's answer for "${slot.id}".`,
      strict: true,
      input_schema: {
        type: 'object',
        properties: { value: valueSchema },
        required: ['value'],
        additionalProperties: false,
      },
    };

    const res = await this.client.messages.create({
      model: this.models.extract,
      max_tokens: 1024,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'record_slot' },
      messages: [
        {
          role: 'user',
          content: `Question asked: ${slot.question}\nUser's answer: ${userText}\n\nExtract the answer into the tool. For "none"/empty, return an empty list (list slots) or a brief value (text slots).`,
        },
      ],
    });

    if (res.stop_reason === 'refusal') throw new Error('Model refused to extract the answer');
    const block = res.content.find((b) => b.type === 'tool_use');
    const value = block?.input?.value;
    if (isList) return Array.isArray(value) ? value.map((x) => String(x)) : [];
    return typeof value === 'string' ? value : String(value ?? '');
  }

  async synthesizeSpec({ values }: { values: SlotValues }): Promise<unknown> {
    const res = await this.client.messages.create({
      model: this.models.synthesize,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: AGENT_SPEC_SCHEMA } },
      system: SYNTH_SYSTEM,
      messages: [
        { role: 'user', content: `Interview answers (JSON):\n${JSON.stringify(values, null, 2)}\n\nProduce the AgentSpec.` },
      ],
    });

    if (res.stop_reason === 'refusal') throw new Error('Model refused to synthesize the AgentSpec');
    const text = res.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('Synthesis returned no content');
    return JSON.parse(text);
  }
}
