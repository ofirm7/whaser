import type { AgentSpec, AgentTool, SubAgent, WorkflowRoute } from './schema';
import type { AnthropicLike } from './llm';

export type ExtensionKind = 'context' | 'skill' | 'workflow';

export interface ContextExtension {
  kind: 'context';
  summary: string;
  knowledge: { type: 'text' | 'url'; label: string; content: string }[];
}
export interface SkillExtension {
  kind: 'skill';
  summary: string;
  skill: { name: string; description: string; instructions: string };
}
export interface WorkflowExtension {
  kind: 'workflow';
  summary: string;
  subAgent: SubAgent;
  route: WorkflowRoute;
  newTools: AgentTool[];
}
export type SpecExtension = ContextExtension | SkillExtension | WorkflowExtension;

/** Propose a spec extension from a user's request (prior powers the "Ask Changes" loop). Mockable. */
export interface Extender {
  propose(args: { spec: AgentSpec; kind: ExtensionKind; instruction: string; prior?: SpecExtension | null }): Promise<SpecExtension>;
  /** One conversational turn of the "improve this agent" chat: reply + (when agreed) a change to propose. */
  improveInterview(args: { spec: AgentSpec; messages: Array<{ role: 'user' | 'assistant'; content: string }> }): Promise<{ reply: string; proposeKind: ExtensionKind | 'none'; proposeInstruction: string }>;
}

const TOOL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'description', 'parameters', 'side_effecting'],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    parameters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type', 'description', 'required'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string' },
          description: { type: 'string' },
          required: { type: 'boolean' },
        },
      },
    },
    side_effecting: { type: 'boolean' },
  },
};

/** Structured-output schema per extension kind (closed objects; `kind` is added by the caller). */
export const EXTENSION_SCHEMAS: Record<ExtensionKind, Record<string, unknown>> = {
  context: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'knowledge'],
    properties: {
      summary: { type: 'string' },
      knowledge: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'label', 'content'],
          properties: { type: { type: 'string', enum: ['text', 'url'] }, label: { type: 'string' }, content: { type: 'string' } },
        },
      },
    },
  },
  skill: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'skill'],
    properties: {
      summary: { type: 'string' },
      skill: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'instructions'],
        properties: { name: { type: 'string' }, description: { type: 'string' }, instructions: { type: 'string' } },
      },
    },
  },
  workflow: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'subAgent', 'route', 'newTools'],
    properties: {
      summary: { type: 'string' },
      subAgent: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name', 'specialty', 'tool_names'],
        properties: { id: { type: 'string' }, name: { type: 'string' }, specialty: { type: 'string' }, tool_names: { type: 'array', items: { type: 'string' } } },
      },
      route: {
        type: 'object',
        additionalProperties: false,
        required: ['intent', 'description', 'target'],
        properties: { intent: { type: 'string' }, description: { type: 'string' }, target: { type: 'string' } },
      },
      newTools: { type: 'array', items: TOOL_SCHEMA },
    },
  },
};

/**
 * Apply a (user-approved) extension to a spec, returning a NEW spec with version bumped. Pure +
 * deduping; callers should still re-validate + consistency-check.
 */
export function applyExtension(spec: AgentSpec, ext: SpecExtension): AgentSpec {
  const next: AgentSpec = {
    ...spec,
    version: spec.version + 1,
    knowledge_sources: [...spec.knowledge_sources],
    tools: [...spec.tools],
    sub_agents: [...spec.sub_agents],
    skills: [...(spec.skills ?? [])],
    workflow: { ...spec.workflow, routes: [...spec.workflow.routes] },
  };

  if (ext.kind === 'context') {
    for (const k of ext.knowledge ?? []) {
      const content = (k.content ?? '').trim();
      if (!content) continue;
      next.knowledge_sources.push({ type: k.type === 'url' ? 'url' : 'text', label: (k.label ?? '').trim() || 'note', content });
    }
  } else if (ext.kind === 'skill') {
    const name = (ext.skill?.name ?? '').trim();
    if (name) {
      const skill = { name, description: (ext.skill.description ?? '').trim(), instructions: (ext.skill.instructions ?? '').trim() };
      const idx = next.skills!.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
      if (idx >= 0) next.skills![idx] = skill;
      else next.skills!.push(skill);
    }
  } else if (ext.kind === 'workflow') {
    const haveTool = new Set(next.tools.map((t) => t.name.toLowerCase()));
    for (const t of ext.newTools ?? []) {
      if (t?.name && !haveTool.has(t.name.toLowerCase())) {
        next.tools.push(t);
        haveTool.add(t.name.toLowerCase());
      }
    }
    const sa = ext.subAgent;
    if (sa?.id && !next.sub_agents.some((x) => x.id === sa.id)) next.sub_agents.push(sa);
    next.workflow.mode = 'router';
    const r = ext.route;
    if (r?.intent && !next.workflow.routes.some((x) => x.intent === r.intent && x.target === r.target)) next.workflow.routes.push(r);
  }
  return next;
}

const SYS: Record<ExtensionKind, string> = {
  context:
    'You add knowledge/context to an existing WhatsApp agent. From the request, produce concise, factual ' +
    'knowledge items the agent can rely on. Use type "text" with a short label + the content; use type "url" ' +
    'only for a bare link to reference. Put a one-line human summary in `summary`.',
  skill:
    'You build a Claude Agent Skill (SKILL.md) for an existing agent. Produce: name (short kebab-case), ' +
    'description (what it does AND when to use it — specific and a little "pushy" so it triggers), and ' +
    'instructions (an imperative markdown body the agent follows, with clear steps/examples). Keep it focused. ' +
    'Put a one-line human summary in `summary`.',
  workflow:
    'You add a router sub-agent (a new task area) to an existing agent. Produce subAgent {id (kebab-case, ' +
    'unique vs existing sub_agents), name, specialty, tool_names} and one route {intent, description (when it ' +
    'applies), target} where target EQUALS subAgent.id. If the sub-agent needs tools not already in tools[], ' +
    'define them in newTools (closed parameters; side_effecting only if it writes/calls an external system) and ' +
    'list them in tool_names; otherwise newTools=[] and tool_names must reference existing tools. Summary in `summary`.',
};

const IMPROVE_SYS = [
  'You are helping the OWNER improve their existing WhatsApp AI agent (its current AgentSpec is given).',
  'Have a natural, plain-language conversation: understand what they want to improve, investigate the',
  'current setup, ask one short clarifying question at a time, and suggest concrete improvements. The',
  'audience is NON-technical — keep it simple, warm, and jargon-free.',
  'When (and only when) you and the owner have agreed on a SPECIFIC change to apply now, set propose_kind',
  'to one of: context (add knowledge/info it should know), skill (a reusable how-to), or workflow (a new',
  'task area / sub-agent); and put a clear, complete instruction in propose_instruction describing exactly',
  'the change to make. Otherwise set propose_kind="none" and keep the conversation going. After a change is',
  'applied, you can propose more or tell them they are all set. Always reply in the owner\'s language.',
].join(' ');

const IMPROVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'propose_kind', 'propose_instruction'],
  properties: {
    reply: { type: 'string', description: 'Your next message to the owner — plain, simple, friendly.' },
    propose_kind: { type: 'string', enum: ['none', 'context', 'skill', 'workflow'], description: "Only set to a kind when a specific change is agreed to apply now; else 'none'." },
    propose_instruction: { type: 'string', description: 'When propose_kind is not none, a clear instruction describing exactly the change; else empty.' },
  },
};

/** Claude-backed extender (structured output). Inject an AnthropicLike client. */
export class AnthropicExtender implements Extender {
  private readonly client: AnthropicLike;
  private readonly model: string;

  constructor(opts: { client: AnthropicLike; model?: string }) {
    this.client = opts.client;
    this.model = opts.model ?? 'claude-sonnet-4-6';
  }

  async propose({ spec, kind, instruction, prior }: { spec: AgentSpec; kind: ExtensionKind; instruction: string; prior?: SpecExtension | null }): Promise<SpecExtension> {
    const priorBlock = prior ? `\n\nYour previous draft (revise it per the change request):\n${JSON.stringify(prior, null, 2)}` : '';
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: EXTENSION_SCHEMAS[kind] } },
      system: SYS[kind],
      messages: [
        {
          role: 'user',
          content: `Existing AgentSpec:\n${JSON.stringify(spec, null, 2)}\n\nRequest: ${instruction}${priorBlock}\n\nProduce the ${kind} extension.`,
        },
      ],
    });
    if (res.stop_reason === 'refusal') throw new Error('Model refused to propose the extension');
    const text = res.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('Extender returned no content');
    return { kind, ...(JSON.parse(text) as object) } as SpecExtension;
  }

  async improveInterview({ spec, messages }: { spec: AgentSpec; messages: Array<{ role: 'user' | 'assistant'; content: string }> }): Promise<{ reply: string; proposeKind: ExtensionKind | 'none'; proposeInstruction: string }> {
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: IMPROVE_SCHEMA } },
      system: IMPROVE_SYS,
      messages: [{ role: 'user', content: `Current AgentSpec:\n${JSON.stringify(spec)}` }, ...messages],
    });
    if (res.stop_reason === 'refusal') throw new Error('Model refused to continue');
    const text = res.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new Error('Improver returned no content');
    const out = JSON.parse(text) as { reply?: string; propose_kind?: string; propose_instruction?: string };
    if (!out.reply) throw new Error('Improver returned no message');
    const k = out.propose_kind;
    return { reply: out.reply, proposeKind: k === 'context' || k === 'skill' || k === 'workflow' ? k : 'none', proposeInstruction: out.propose_instruction ?? '' };
  }
}
