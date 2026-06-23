export interface RuntimeMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AgentReply {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  finishReason: string;
}

/**
 * Runtime seam: how Whaser obtains an agent's reply. Phase 3 implements this against
 * LibreChat's Agents API; the `@anthropic-ai/sdk` fallback (see docs/AI-FEATURES.md) can
 * implement the same interface if the headless bridge can't be driven.
 */
export interface AgentRuntime {
  complete(args: {
    agentId: string;
    messages: RuntimeMessage[];
    conversationId?: string;
    /** Opaque id of the chat this turn belongs to (the gateway's phone_number_id). Lets the runtime
     *  give the agent on-demand access to that chat's prior history (the built-in chat_history tool). */
    chatId?: string;
    /** Media for the current turn only (base64) — passed to the model, not stored in history. */
    currentTurnMedia?: { kind: 'image' | 'document'; base64: string; mediaType: string; filename?: string };
  }): Promise<AgentReply>;
}

export interface LibreChatAgentClientOptions {
  /** LibreChat base URL, e.g. http://api:3080 (internal) or https://whaser.example.com. */
  baseUrl: string;
  /** LibreChat agent API key (Bearer). Requires the REMOTE_AGENTS:USE role permission. */
  apiKey: string;
  fetchImpl?: typeof fetch;
}

/**
 * Drives LibreChat's OpenAI-compatible Agents API headlessly:
 *   POST {baseUrl}/api/agents/v1/chat/completions
 *   Authorization: Bearer <agent api key>
 *   { model: <agentId>, messages: [...], stream: false }
 *
 * Note: the non-streaming response does NOT echo back the (auto-created) conversation_id, and
 * passing one requires it to pre-exist — so Whaser owns conversation state and sends the full
 * message history each turn rather than relying on LibreChat's conversation_id. `conversationId`
 * is forwarded only when the caller has a pre-existing LibreChat conversation to continue.
 */
export class LibreChatAgentClient implements AgentRuntime {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LibreChatAgentClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(args: {
    agentId: string;
    messages: RuntimeMessage[];
    conversationId?: string;
  }): Promise<AgentReply> {
    const url = `${this.baseUrl}/api/agents/v1/chat/completions`;
    const body: Record<string, unknown> = {
      model: args.agentId,
      messages: args.messages,
      stream: false,
    };
    if (args.conversationId) body.conversation_id = args.conversationId;

    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`LibreChat agent call failed: ${res.status} ${detail}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    return {
      text: choice?.message?.content ?? '',
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      finishReason: choice?.finish_reason ?? 'stop',
    };
  }
}
