import type { SlotSpec, SlotValue, SlotValues } from './slots';
import { AGENT_SPEC_SCHEMA } from './schema';

/**
 * What the wizard needs from an LLM. Implemented against Anthropic Claude below; a fake is
 * trivial to provide in tests (and the `@anthropic-ai/sdk` runtime fallback could implement it).
 */
/** One turn of the free-form agent-design interview. */
export interface InterviewTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmClient {
  /** Extract a typed value for one slot from the user's free-text answer (strict tool use). */
  extractSlot(args: { slot: SlotSpec; userText: string }): Promise<SlotValue>;
  /** Synthesize a full AgentSpec object from the collected slot values (structured output). */
  synthesizeSpec(args: { values: SlotValues }): Promise<unknown>;
  /**
   * One interviewer turn of the conversational builder: given the conversation so far, produce the
   * next assistant message and whether enough is known to design a complete agent.
   */
  interview(args: { messages: InterviewTurn[] }): Promise<{ reply: string; readyToBuild: boolean }>;
  /** Synthesize a full AgentSpec from the whole interview transcript (structured output). */
  synthesizeFromConversation(args: { messages: InterviewTurn[] }): Promise<unknown>;
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

const INTERVIEW_SYSTEM = [
  "You are Whaser's agent-design partner. Through a natural WhatsApp-style chat you help the user design",
  'a WhatsApp AI agent; Whaser then compiles the whole conversation into a complete AgentSpec.',
  'Hold a real conversation — do NOT run a fixed questionnaire. Ask ONE short, focused question at a time,',
  'build on what the user just said, and keep every reply brief and friendly (this is a chat).',
  'Across the conversation make sure you understand: the agent\'s purpose/goal; who messages it; the topics',
  'it should handle and those it should avoid; its tone/persona; its default language; when to hand off to a',
  'human; any reference knowledge; and — importantly — its CAPABILITIES. Proactively explore and suggest',
  'capabilities the user may want: web search / browsing, calling external APIs or webhooks, scheduled or',
  'timed actions (reminders, recurring or follow-up messages), data lookups, and other integrations. If the',
  'user is vague, propose concrete options rather than asking open-endedly.',
  'BIAS TOWARD BUILDING SOON — do NOT over-interrogate. As soon as you roughly know what the agent is for,',
  'who it serves, and any must-have capabilities (usually within 2–4 exchanges), set ready_to_build=true; the',
  'user can always refine afterward. Whenever ready_to_build is true, your reply MUST offer to build — tell the',
  'user you can build it now and they only need to say "build it" (or tap the Build button), and that you can',
  'keep refining if they prefer. If the user signals they are done, or asks you to build / create / deploy the',
  'agent at any point, set ready_to_build=true immediately and confirm you are ready — stop asking questions.',
  'Reply ONLY by calling the `respond` tool. Reply in the user\'s language.',
].join(' ');

const SYNTH_CONV_SYSTEM = [
  'You convert a Whaser agent-design interview transcript into a single valid Whaser AgentSpec JSON object.',
  'Read the WHOLE conversation and capture exactly the agent the user described.',
  'Derive refusal_policy, greeting, and fallback_message from the persona, goal, and scope.',
  'in_scope_topics and out_of_scope_topics MUST be disjoint.',
  'For each capability or action the user wants — including web search/browsing, calling an external API or',
  'webhook, scheduled/timed actions (reminders, recurring or follow-up messages), and data lookups — emit a',
  'tools[] entry with a clear name, a prescriptive "call this when..." description, a closed parameters[] list',
  '(each {name,type,description,required}), and side_effecting=true when it writes to or calls an external',
  'system (webhooks, scheduling, sending messages) and false for read-only search/lookups.',
  'WORKFLOW–AGENT–TOOL: if the agent spans distinct task areas, set workflow.mode="router" with one route per',
  'area (intent + when-it-applies description + target) and a matching sub_agents[] entry (id, name, specialty,',
  'tool_names drawn from tools[]); otherwise workflow.mode="single" with empty routes and empty sub_agents.',
  'Always include both sub_agents and workflow. Set on_no_match="default" unless every unmatched message must',
  'escalate to a human. version=1. needs_sandbox=true only if any tool is side_effecting. model_assignment',
  'defaults to claude-sonnet-4-6; use claude-opus-4-8 only if the goal needs hard reasoning.',
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

  async interview({ messages }: { messages: InterviewTurn[] }): Promise<{ reply: string; readyToBuild: boolean }> {
    const tool = {
      name: 'respond',
      description: 'Send your next message to the user and report whether you have enough to build the agent.',
      strict: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['reply', 'ready_to_build'],
        properties: {
          reply: { type: 'string', description: 'Your next message to the user (short, friendly, one focused question).' },
          ready_to_build: { type: 'boolean', description: 'True once you have enough to design a complete, useful agent.' },
        },
      },
    };
    const res = await this.client.messages.create({
      model: this.models.extract,
      max_tokens: 1024,
      system: INTERVIEW_SYSTEM,
      tools: [tool],
      tool_choice: { type: 'tool', name: 'respond' },
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });
    if (res.stop_reason === 'refusal') throw new Error('Model refused to continue the interview');
    const input = res.content.find((b) => b.type === 'tool_use')?.input;
    const reply = typeof input?.reply === 'string' ? input.reply : '';
    if (!reply) throw new Error('Interviewer returned no message');
    return { reply, readyToBuild: input?.ready_to_build === true };
  }

  async synthesizeFromConversation({ messages }: { messages: InterviewTurn[] }): Promise<unknown> {
    const transcript = messages.map((m) => `${m.role === 'assistant' ? 'Agent designer' : 'User'}: ${m.content}`).join('\n');
    const res = await this.client.messages.create({
      model: this.models.synthesize,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: AGENT_SPEC_SCHEMA } },
      system: SYNTH_CONV_SYSTEM,
      messages: [{ role: 'user', content: `Interview transcript:\n${transcript}\n\nProduce the AgentSpec.` }],
    });
    if (res.stop_reason === 'refusal') throw new Error('Model refused to synthesize the AgentSpec');
    const text = res.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('Synthesis returned no content');
    return JSON.parse(text);
  }
}
