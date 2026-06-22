import { WorkflowEngine } from '../../../packages/agent-builder/src/index';
import type { WorkflowLlm, AgentSpec } from '../../../packages/agent-builder/src/index';
import type { AgentRuntime, AgentReply, RuntimeMessage } from '../../../packages/whatsapp-gateway/src/agentRuntime';

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
    private readonly getExecutor?: (agentId: string) => ((name: string, input: Record<string, unknown>) => Promise<string>) | undefined,
  ) {}

  async complete({ agentId, messages, currentTurnMedia, noTools }: { agentId: string; messages: RuntimeMessage[]; conversationId?: string; currentTurnMedia?: { kind: 'image' | 'document'; base64: string; mediaType: string; filename?: string }; noTools?: boolean }): Promise<AgentReply> {
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
    // noTools = a safe "test run" (no executor) so testing an agent never fires real side-effects (send/schedule).
    const r = await new WorkflowEngine(spec, llm).handle(wmsgs, currentTurnMedia, noTools ? undefined : this.getExecutor?.(agentId));
    this.lastRoutedTo = r.routedTo;
    this.lastUsage = r.usage;
    return { text: r.text, usage: r.usage, finishReason: 'stop' };
  }
}
