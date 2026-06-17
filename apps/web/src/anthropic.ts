import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicLike, AnthropicCreateParams, AnthropicMessage, AgentSpec } from '../../../packages/agent-builder/src/index';
import { renderInstructions } from '../../../packages/agent-builder/src/index';
import type { AgentRuntime, AgentReply, RuntimeMessage } from '../../../packages/whatsapp-gateway/src/agentRuntime';

/** Minimal shape we read off the SDK response (avoids pinning version-specific type names). */
interface RawMessage {
  content: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown> }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Adapts the real Anthropic SDK to the agent-builder's `AnthropicLike` seam. The
 * `AnthropicLlmClient` already sets the verified conventions (output_config.format for synthesis,
 * strict tool use for extraction, adaptive thinking, refusal checks); we pass them through.
 */
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
 * Direct Claude runtime for the WhatsApp simulator — the `@anthropic-ai/sdk` fallback path from
 * docs/AI-FEATURES.md. Uses the rendered AgentSpec as the system prompt; production uses
 * LibreChatAgentClient against a running LibreChat agent instead.
 */
export class AnthropicAgentRuntime implements AgentRuntime {
  private readonly create: (p: unknown) => Promise<unknown>;

  constructor(apiKey: string, private readonly getSpec: (agentId: string) => AgentSpec | undefined) {
    const sdk = new Anthropic({ apiKey });
    this.create = sdk.messages.create.bind(sdk.messages) as (p: unknown) => Promise<unknown>;
  }

  async complete({ agentId, messages }: { agentId: string; messages: RuntimeMessage[]; conversationId?: string }): Promise<AgentReply> {
    const spec = this.getSpec(agentId);
    if (!spec) {
      return { text: "This agent isn't available.", usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop' };
    }
    const res = (await this.create({
      model: spec.model_assignment,
      max_tokens: 1024,
      system: renderInstructions(spec),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    })) as RawMessage;

    if (res.stop_reason === 'refusal') {
      return { text: spec.fallback_message, usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'refusal' };
    }
    const text = res.content.find((b) => b.type === 'text')?.text ?? spec.fallback_message;
    return {
      text,
      usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
      finishReason: 'stop',
    };
  }
}
