import { WorkflowEngine } from '../../../packages/agent-builder/src/index';
import type { WorkflowLlm, AgentSpec, AgentTool } from '../../../packages/agent-builder/src/index';
import type { AgentRuntime, AgentReply, RuntimeMessage } from '../../../packages/whatsapp-gateway/src/agentRuntime';

/** Reserved name of the built-in, always-available tool that lets ANY agent read the chat's prior
 *  WhatsApp history on demand (the messages that existed before it was created/deployed). Handled by
 *  the app's tool executor against the linked channel's per-chat buffer. */
export const CHAT_HISTORY_TOOL = 'chat_history';

/** The built-in chat_history tool, as an AgentTool. Injected as an "ambient" tool (outside the spec)
 *  on any reply that has a real WhatsApp chat context, so agents can look back / search when ASKED —
 *  rather than carrying the whole history in every turn's context (smart on token usage). */
export const chatHistoryTool: AgentTool = {
  name: CHAT_HISTORY_TOOL,
  description:
    "Look up earlier messages from THIS WhatsApp chat — including ones sent before you existed. Use it " +
    "ONLY when the user refers to something from earlier, asks what was already discussed/agreed/sent, or " +
    "you need older context you don't already have. Returns a compact, recent slice oldest→newest; pass " +
    "`query` to find specific past messages by keyword. Don't call it for normal replies.",
  parameters: [
    { name: 'query', type: 'string', description: 'Optional keyword/phrase to filter for matching past messages (case-insensitive).', required: false },
    { name: 'limit', type: 'number', description: 'Optional max number of messages to return (default 20, max 40).', required: false },
  ],
  side_effecting: false,
};

/** True when the gateway's chatId carries a real WhatsApp jid (personal channel encodes `tenant::jid`).
 *  SIM/trigger contexts have no such chat, so the chat_history tool isn't offered there. */
function hasChatContext(chatId?: string): boolean {
  return !!chatId && (chatId.includes('@s.whatsapp.net') || chatId.includes('@g.us'));
}

/**
 * Bridges the WAT WorkflowEngine to the gateway's AgentRuntime interface. Each inbound message
 * runs the agent's workflow (route → sub-agent → reply). `lastRoutedTo` exposes which sub-agent
 * handled the most recent message (surfaced in the simulator UI).
 */
export class WorkflowAgentRuntime implements AgentRuntime {
  lastRoutedTo = 'default';
  lastUsage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 };

  constructor(
    private readonly getSpec: (agentId: string) => AgentSpec | undefined,
    private readonly llm: WorkflowLlm,
    private readonly getStylePreamble?: (agentId: string) => string,
    private readonly getExecutor?: (agentId: string, chatId?: string) => ((name: string, input: Record<string, unknown>) => Promise<string>) | undefined,
  ) {}

  async complete({ agentId, messages, chatId, currentTurnMedia, noTools, executor }: { agentId: string; messages: RuntimeMessage[]; conversationId?: string; chatId?: string; currentTurnMedia?: { kind: 'image' | 'document'; base64: string; mediaType: string; filename?: string }; noTools?: boolean; executor?: (name: string, input: Record<string, unknown>) => Promise<string> }): Promise<AgentReply> {
    const spec = this.getSpec(agentId);
    if (!spec) {
      this.lastRoutedTo = 'default';
      this.lastUsage = { inputTokens: 0, outputTokens: 0 };
      return { text: "This agent isn't available.", usage: { inputTokens: 0, outputTokens: 0 }, finishReason: 'stop' };
    }
    // Per-call style injection for this agent's owner (no shared mutable state).
    const pre = this.getStylePreamble?.(agentId) ?? '';
    const llm: WorkflowLlm = pre
      ? { classifyIntent: (a) => this.llm.classifyIntent(a), reply: (a) => this.llm.reply({ ...a, systemPrompt: `${pre}\n\n${a.systemPrompt}` }) }
      : this.llm;
    const wmsgs = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    // executor override = a sandboxed "test run" (real read tools, simulated sends) so a test faithfully
    // mirrors production without real side-effects. noTools = no executor at all. Else the live executor.
    const exec = executor ?? (noTools ? undefined : this.getExecutor?.(agentId, chatId));
    // Offer the built-in chat_history tool only when this turn is in a real WhatsApp chat (so the agent
    // can fetch the thread's prior messages on demand). It bypasses sub-agent tool allow-lists.
    const ambientTools = exec && hasChatContext(chatId) ? [chatHistoryTool] : undefined;
    const r = await new WorkflowEngine(spec, llm).handle(wmsgs, currentTurnMedia, exec, ambientTools);
    this.lastRoutedTo = r.routedTo;
    this.lastUsage = r.usage;
    return { text: r.text, usage: r.usage, finishReason: 'stop' };
  }
}
