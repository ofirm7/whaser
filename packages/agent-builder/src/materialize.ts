import type { AgentSpec, AgentTool } from './schema';

/** Derive a JSON-Schema input_schema (closed) from a tool's closed parameter list. */
function toInputSchema(tool: AgentTool): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const p of tool.parameters) properties[p.name] = { type: p.type, description: p.description };
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required: tool.parameters.filter((p) => p.required).map((p) => p.name),
  };
}

export interface LibreChatAgentPayload {
  name: string;
  /** One byte-stable system-prompt block (prompt-cacheable). */
  instructions: string;
  provider: 'anthropic';
  model: string;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  metadata: {
    whaser: {
      specVersion: number;
      sideEffectingTools: string[];
      needsSandbox: boolean;
      defaultLanguage: string;
      workflowMode: 'single' | 'router';
      subAgentIds: string[];
    };
  };
}

/** Compose the AgentSpec into a single, frozen instructions block (the runtime system prompt). */
export function renderInstructions(spec: AgentSpec): string {
  const sections: string[] = [];
  sections.push(`You are ${spec.agent_name}, a WhatsApp assistant.`);
  sections.push(`Tone: ${spec.brand_persona.tone}. ${spec.brand_persona.style_notes}`.trim());
  sections.push(`Primary goal: ${spec.goal}`);
  if (spec.in_scope_topics.length) sections.push(`In scope: ${spec.in_scope_topics.join('; ')}.`);
  if (spec.out_of_scope_topics.length) sections.push(`Out of scope: ${spec.out_of_scope_topics.join('; ')}.`);
  sections.push(`Refusal policy: ${spec.refusal_policy}`);
  if (spec.escalation_rules.length) {
    const rules = spec.escalation_rules.map((r) => `when ${r.when} -> ${r.action}`).join('; ');
    sections.push(`Escalation: ${rules}.`);
  }
  sections.push(`Default language: ${spec.default_language}.`);
  sections.push(`Greeting: ${spec.greeting}`);
  sections.push(`If you cannot help: ${spec.fallback_message}`);
  const textKnowledge = spec.knowledge_sources.filter((k) => k.type === 'text');
  if (textKnowledge.length) {
    const refs = textKnowledge.map((k) => `${k.label}: ${k.content}`).join('\n');
    sections.push(`Reference information:\n${refs}`);
  }
  return sections.filter(Boolean).join('\n\n');
}

/** Map a published AgentSpec onto a LibreChat agent payload (see docs/AI-FEATURES.md). */
export function toLibreChatAgent(spec: AgentSpec): LibreChatAgentPayload {
  return {
    name: spec.agent_name,
    instructions: renderInstructions(spec),
    provider: 'anthropic',
    model: spec.model_assignment,
    tools: spec.tools.map((t) => ({ name: t.name, description: t.description, input_schema: toInputSchema(t) })),
    metadata: {
      whaser: {
        specVersion: spec.version,
        sideEffectingTools: spec.tools.filter((t) => t.side_effecting).map((t) => t.name),
        needsSandbox: spec.needs_sandbox,
        defaultLanguage: spec.default_language,
        workflowMode: spec.workflow.mode,
        subAgentIds: spec.sub_agents.map((s) => s.id),
      },
    },
  };
}
