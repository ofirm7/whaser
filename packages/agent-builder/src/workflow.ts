import type { AgentSpec, SubAgent, AgentTool } from './schema';
import { renderInstructions } from './materialize';

export interface WorkflowRuntimeMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Media for the current turn only (base64) — attached to the latest user message at reply time.
 *  kind selects the Anthropic block: 'image' -> image block (vision), 'document' -> document block (PDF). */
export interface WorkflowMedia {
  kind: 'image' | 'document';
  base64: string;
  mediaType: string;
  filename?: string;
}

export interface WorkflowReply {
  text: string;
  /** sub-agent id that handled it, or 'default' / 'handoff'. */
  routedTo: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** Executes one of the agent's declared tools and returns a text result for the model. */
export type ToolExecutor = (name: string, input: Record<string, unknown>) => Promise<string>;

/** The Workflow–Agent–Tool engine's LLM seam: classify intent + produce a reply. Mockable. */
export interface WorkflowLlm {
  classifyIntent(args: { message: string; routes: Array<{ intent: string; description: string }> }): Promise<string | null>;
  reply(args: { systemPrompt: string; messages: WorkflowRuntimeMessage[]; media?: WorkflowMedia; tools?: AgentTool[]; executeToolCall?: ToolExecutor }): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }>;
}

/** Root identity + (when routed) the selected sub-agent's specialty and allowed tools. */
export function composeSystemPrompt(spec: AgentSpec, subAgent: SubAgent | null): string {
  const base = renderInstructions(spec);
  if (!subAgent) return base;
  const tools = subAgent.tool_names.length ? ` You may use these tools: ${subAgent.tool_names.join(', ')}.` : '';
  return `${base}\n\nYou are handling this conversation as the "${subAgent.name}" specialist. ${subAgent.specialty}${tools}`;
}

export function handoffMessage(spec: AgentSpec): string {
  return `${spec.fallback_message} Let me connect you with a human who can help.`;
}

/**
 * Executes an AgentSpec as a Workflow–Agent–Tool: a router classifies the inbound message to an
 * intent, delegates to the matching sub-agent (its specialty + allowed tools), and that agent
 * replies. `single` mode (or no routes) → the root/default agent answers directly.
 */
export class WorkflowEngine {
  constructor(private readonly spec: AgentSpec, private readonly llm: WorkflowLlm) {}

  async handle(messages: WorkflowRuntimeMessage[], media?: WorkflowMedia, executeToolCall?: ToolExecutor): Promise<WorkflowReply> {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    let subAgent: SubAgent | null = null;
    let routedTo = 'default';

    const wf = this.spec.workflow;
    if (wf.mode === 'router' && wf.routes.length > 0) {
      const intent = await this.llm.classifyIntent({
        message: lastUser,
        routes: wf.routes.map((r) => ({ intent: r.intent, description: r.description })),
      });
      const route = intent ? wf.routes.find((r) => r.intent === intent) : undefined;
      const target = route ? this.spec.sub_agents.find((s) => s.id === route.target) : undefined;
      if (target) {
        subAgent = target;
        routedTo = target.id;
      } else if (wf.on_no_match === 'handoff') {
        return { text: handoffMessage(this.spec), routedTo: 'handoff', usage: { inputTokens: 0, outputTokens: 0 } };
      }
    }

    // Give the model its declared tools (filtered to the routed sub-agent's allow-list) so it can
    // actually act, not just describe. The executor runs each call against a real platform backend.
    const tools = executeToolCall
      ? subAgent && subAgent.tool_names.length
        ? this.spec.tools.filter((t) => subAgent.tool_names.includes(t.name))
        : this.spec.tools
      : undefined;
    const r = await this.llm.reply({ systemPrompt: composeSystemPrompt(this.spec, subAgent), messages, media, tools, executeToolCall });
    return { text: r.text, routedTo, usage: r.usage };
  }
}
