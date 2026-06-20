import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicLike, AnthropicCreateParams, AnthropicMessage } from '../../../packages/agent-builder/src/index';
import type { WorkflowLlm, WorkflowRuntimeMessage, WorkflowMedia } from '../../../packages/agent-builder/src/index';

interface RawMessage {
  content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
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

  async reply({ systemPrompt, messages, media }: { systemPrompt: string; messages: WorkflowRuntimeMessage[]; media?: WorkflowMedia }): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
    // Attach the current-turn media (if any) to the LAST user message: image -> image block (vision),
    // document(PDF) -> document block. Audio/video never reach here (the API has no such block).
    const lastUserIdx = media ? messages.map((m) => m.role).lastIndexOf('user') : -1;
    const apiMessages = messages.map((m, i): { role: string; content: unknown } => {
      if (i === lastUserIdx && media) {
        const block =
          media.kind === 'document'
            ? { type: 'document', source: { type: 'base64', media_type: media.mediaType, data: media.base64 }, ...(media.filename ? { title: media.filename } : {}) }
            : { type: 'image', source: { type: 'base64', media_type: media.mediaType, data: media.base64 } };
        return { role: m.role, content: [block, ...(m.content.trim() ? [{ type: 'text', text: m.content }] : [])] };
      }
      return { role: m.role, content: m.content };
    });
    const res = (await this.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: apiMessages,
    })) as RawMessage;
    const text = res.stop_reason === 'refusal' ? "I'm sorry, I can't help with that." : res.content.find((b) => b.type === 'text')?.text ?? '';
    return { text, usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 } };
  }
}
