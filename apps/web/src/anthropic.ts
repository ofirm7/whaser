import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicLike, AnthropicCreateParams, AnthropicMessage, AgentTool, ToolExecutor } from '../../../packages/agent-builder/src/index';
import { toInputSchema } from '../../../packages/agent-builder/src/index';
import type { WorkflowLlm, WorkflowRuntimeMessage, WorkflowMedia } from '../../../packages/agent-builder/src/index';

interface RawMessage {
  // `id` is kept so tool_use blocks can be echoed back + matched to their tool_result.
  content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown>; id?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Adapts the real Anthropic SDK to the agent-builder's `AnthropicLike` seam (wizard path). */
export function makeAnthropicLike(apiKey: string): AnthropicLike {
  const sdk = new Anthropic({ apiKey });
  const create = sdk.messages.create.bind(sdk.messages) as (p: unknown) => Promise<unknown>;
  return {
    messages: {
      async create(params: AnthropicCreateParams): Promise<AnthropicMessage> {
        const res = (await create(params)) as RawMessage;
        return {
          content: res.content.map((b) => ({ type: b.type, text: b.text, name: b.name, input: b.input })),
          stop_reason: res.stop_reason,
        };
      },
    },
  };
}

/**
 * Claude-backed WAT engine LLM: intent classification (Haiku, strict tool use) + agent reply
 * (Sonnet, the composed system prompt). The `@anthropic-ai/sdk` direct path from AI-FEATURES;
 * production routes replies through LibreChat's agent runtime instead.
 */
export class AnthropicWorkflowLlm implements WorkflowLlm {
  private readonly create: (p: unknown) => Promise<unknown>;

  constructor(apiKey: string) {
    const sdk = new Anthropic({ apiKey });
    this.create = sdk.messages.create.bind(sdk.messages) as (p: unknown) => Promise<unknown>;
  }

  async classifyIntent({ message, routes }: { message: string; routes: Array<{ intent: string; description: string }> }): Promise<string | null> {
    const intents = routes.map((r) => r.intent);
    const list = routes.map((r) => `- ${r.intent}: ${r.description}`).join('\n');
    const res = (await this.create({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      tools: [
        {
          name: 'route',
          description: 'Pick the single best-matching intent for the user message, or "none".',
          input_schema: {
            type: 'object',
            additionalProperties: false,
            required: ['intent'],
            properties: { intent: { type: 'string', enum: [...intents, 'none'] } },
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'route' },
      messages: [{ role: 'user', content: `Intents:\n${list}\n\nUser message: ${message}` }],
    })) as RawMessage;
    const intent = res.content.find((b) => b.type === 'tool_use')?.input?.intent;
    return typeof intent === 'string' && intent !== 'none' && intents.includes(intent) ? intent : null;
  }

  async reply({ systemPrompt, messages, media, tools, executeToolCall }: { systemPrompt: string; messages: WorkflowRuntimeMessage[]; media?: WorkflowMedia; tools?: AgentTool[]; executeToolCall?: ToolExecutor }): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
    // Attach the current-turn media (if any) to the LAST user message: image -> image block (vision),
    // document(PDF) -> document block. Audio/video never reach here (the API has no such block).
    const lastUserIdx = media ? messages.map((m) => m.role).lastIndexOf('user') : -1;
    const convo: Array<{ role: string; content: unknown }> = messages.map((m, i) => {
      if (i === lastUserIdx && media) {
        const block =
          media.kind === 'document'
            ? { type: 'document', source: { type: 'base64', media_type: media.mediaType, data: media.base64 }, ...(media.filename ? { title: media.filename } : {}) }
            : { type: 'image', source: { type: 'base64', media_type: media.mediaType, data: media.base64 } };
        return { role: m.role, content: [block, ...(m.content.trim() ? [{ type: 'text', text: m.content }] : [])] };
      }
      return { role: m.role, content: m.content };
    });

    // Give the agent its declared tools as REAL callable tools + Anthropic's server-side web search,
    // so it actually performs its capabilities instead of saying it lacks them.
    const useTools = !!(tools && tools.length && executeToolCall);
    const apiTools = useTools
      ? [
          ...tools!.map((t) => ({ name: t.name, description: t.description, input_schema: toInputSchema(t) })),
          { type: 'web_search_20250305', name: 'web_search', max_uses: 4 },
        ]
      : undefined;

    let inTok = 0, outTok = 0;
    for (let i = 0; i < 6; i++) {
      const res = (await this.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: convo,
        ...(apiTools ? { tools: apiTools } : {}),
      })) as RawMessage;
      inTok += res.usage?.input_tokens ?? 0;
      outTok += res.usage?.output_tokens ?? 0;
      if (res.stop_reason === 'refusal') return { text: "I'm sorry, I can't help with that.", usage: { inputTokens: inTok, outputTokens: outTok } };

      const calls = res.content.filter((b) => b.type === 'tool_use' && b.id && b.name); // our custom tools (web search is server-side)
      if (res.stop_reason === 'tool_use' && calls.length && executeToolCall) {
        convo.push({ role: 'assistant', content: res.content }); // MUST echo the tool_use blocks back
        const results: unknown[] = [];
        for (const c of calls) {
          let out: string;
          try { out = await executeToolCall(c.name as string, (c.input ?? {}) as Record<string, unknown>); }
          catch (e) { out = `Error running ${c.name}: ${e instanceof Error ? e.message : String(e)}`; }
          results.push({ type: 'tool_result', tool_use_id: c.id, content: out });
        }
        convo.push({ role: 'user', content: results });
        continue;
      }
      if (res.stop_reason === 'pause_turn') { convo.push({ role: 'assistant', content: res.content }); continue; } // resume server tool
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
      return { text, usage: { inputTokens: inTok, outputTokens: outTok } };
    }
    return { text: '', usage: { inputTokens: inTok, outputTokens: outTok } }; // tool-loop cap reached
  }

  /** The "improve this agent" chat: a tool-using loop where the AI can TEST the agent (run it and see
   *  its reply) and CHANGE it (apply a context/skill/workflow improvement) directly. The executor wires
   *  test_agent + apply_improvement to the live agent. */
  async improveChat({ systemPrompt, messages, executeToolCall }: { systemPrompt: string; messages: WorkflowRuntimeMessage[]; executeToolCall: (name: string, input: Record<string, unknown>) => Promise<string> }): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
    const apiTools = [
      { name: 'test_agent', description: 'Send a test message to THIS agent (the one being improved) and get back exactly how it replies. Consecutive calls continue the SAME test conversation (so you can check whether it remembers earlier messages); set fresh=true to start a brand-new conversation. Use it to investigate current behavior, and again after a change to verify it worked.', input_schema: { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string', description: 'A realistic message a real user would send the agent.' }, fresh: { type: 'boolean', description: 'Start a new conversation (clear prior test turns) before sending this message.' } } } },
      { name: 'apply_improvement', description: 'Apply a concrete improvement to THIS agent right now (it is paused, so it is safe to edit). Use only after the owner has agreed to the change.', input_schema: { type: 'object', additionalProperties: false, required: ['kind', 'instruction'], properties: { kind: { type: 'string', enum: ['context', 'skill', 'workflow'], description: 'context = add info it should know; skill = a reusable how-to; workflow = a new task area / sub-agent.' }, instruction: { type: 'string', description: 'A clear, complete description of exactly the change to make.' } } } },
    ];
    const convo: Array<{ role: string; content: unknown }> = messages.map((m) => ({ role: m.role, content: m.content }));
    let inTok = 0, outTok = 0;
    for (let i = 0; i < 8; i++) {
      const res = (await this.create({ model: 'claude-sonnet-4-6', max_tokens: 1024, system: systemPrompt, tools: apiTools, messages: convo })) as RawMessage;
      inTok += res.usage?.input_tokens ?? 0;
      outTok += res.usage?.output_tokens ?? 0;
      if (res.stop_reason === 'refusal') return { text: "I'm sorry, I can't help with that.", usage: { inputTokens: inTok, outputTokens: outTok } };
      const calls = res.content.filter((b) => b.type === 'tool_use' && b.id && b.name);
      if (res.stop_reason === 'tool_use' && calls.length) {
        convo.push({ role: 'assistant', content: res.content });
        const results: unknown[] = [];
        for (const c of calls) {
          let out: string;
          try { out = await executeToolCall(c.name as string, (c.input ?? {}) as Record<string, unknown>); }
          catch (e) { out = `Error: ${e instanceof Error ? e.message : String(e)}`; }
          results.push({ type: 'tool_result', tool_use_id: c.id, content: out });
        }
        convo.push({ role: 'user', content: results });
        continue;
      }
      const text = res.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('').trim();
      return { text, usage: { inputTokens: inTok, outputTokens: outTok } };
    }
    return { text: '', usage: { inputTokens: inTok, outputTokens: outTok } };
  }
}
