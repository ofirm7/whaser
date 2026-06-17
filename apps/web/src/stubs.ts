import type { LlmClient, SlotSpec, SlotValue, SlotValues, AgentSpec } from '../../../packages/agent-builder/src/index';
import type { AgentRuntime, AgentReply, RuntimeMessage } from '../../../packages/whatsapp-gateway/src/agentRuntime';

const asList = (v: SlotValue | undefined): string[] => (Array.isArray(v) ? v : []);
const asText = (v: SlotValue | undefined): string => (typeof v === 'string' ? v : '');

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'tool';
}

const NONE = /^\s*(none|no|n\/a|na|nothing|skip)\s*$/i;

/**
 * Deterministic stand-in for AnthropicLlmClient — lets the wizard run with no Anthropic key.
 * In production, swap for `new AnthropicLlmClient({ client })`.
 */
export class StubLlmClient implements LlmClient {
  async extractSlot({ slot, userText }: { slot: SlotSpec; userText: string }): Promise<SlotValue> {
    if (slot.kind === 'list') {
      if (NONE.test(userText)) return [];
      return userText
        .split(/[,;]| and /i)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }
    return userText.trim();
  }

  async synthesizeSpec({ values }: { values: SlotValues }): Promise<unknown> {
    const name = asText(values.agent_name) || 'My Agent';
    const goal = asText(values.goal) || 'help customers';
    const inScope = asList(values.in_scope_topics);
    const inLower = new Set(inScope.map((s) => s.toLowerCase()));
    const outScope = asList(values.out_of_scope_topics).filter((t) => !inLower.has(t.toLowerCase()));
    const used = new Set<string>();
    const tools = asList(values.tools).map((t) => {
      let n = slugify(t);
      while (used.has(n)) n = `${n}_x`;
      used.add(n);
      return {
        name: n,
        description: `Call this when the user needs: ${t}.`,
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        side_effecting: false,
      };
    });
    const knowledge = asList(values.knowledge_sources).map((k, i) => ({ type: 'text', label: `source_${i + 1}`, content: k }));
    const lang = /eng/i.test(asText(values.default_language)) ? 'en' : asText(values.default_language) || 'en';

    const spec: AgentSpec = {
      version: 1,
      agent_name: name,
      brand_persona: { tone: asText(values.tone) || 'friendly', style_notes: 'Be concise and clear — this is a WhatsApp chat.' },
      goal,
      in_scope_topics: inScope,
      out_of_scope_topics: outScope,
      refusal_policy: inScope.length
        ? `Politely decline anything outside ${inScope.join(', ')}; offer a human handoff.`
        : 'Politely decline out-of-scope requests; offer a human handoff.',
      escalation_rules: [{ when: asText(values.escalation) || 'the user asks for a human', action: 'handoff' }],
      tools,
      knowledge_sources: knowledge,
      default_language: lang,
      greeting: `Hi! I'm ${name}. How can I help?`,
      fallback_message: "Sorry, I didn't catch that — could you rephrase?",
      model_assignment: 'claude-sonnet-4-6',
      needs_sandbox: false,
    };
    return spec;
  }
}

/**
 * Deterministic stand-in for the LibreChat agent runtime — replies in-persona from the spec,
 * so the WhatsApp simulator works with no Anthropic key. In production this is the
 * LibreChatAgentClient driving a real agent.
 */
export class StubAgentRuntime implements AgentRuntime {
  constructor(private readonly getSpec: (agentId: string) => AgentSpec | undefined) {}

  async complete({ agentId, messages }: { agentId: string; messages: RuntimeMessage[]; conversationId?: string }): Promise<AgentReply> {
    const spec = this.getSpec(agentId);
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const hasPriorAssistant = messages.some((m) => m.role === 'assistant');

    let text: string;
    if (!spec) {
      text = "This agent isn't available right now.";
    } else if (!hasPriorAssistant) {
      text = spec.greeting;
    } else {
      const lower = lastUser.toLowerCase();
      const inHit = spec.in_scope_topics.find((t) => lower.includes(t.toLowerCase()));
      const outHit = spec.out_of_scope_topics.find((t) => lower.includes(t.toLowerCase()));
      if (outHit) {
        text = spec.refusal_policy;
      } else if (inHit) {
        text = `Happy to help with ${inHit}. (demo reply — connect an Anthropic key for real answers.) You said: “${lastUser}”.`;
      } else {
        const topics = spec.in_scope_topics.join(', ') || 'your question';
        text = `I can help with ${topics}. (demo reply) You said: “${lastUser}”.`;
      }
    }

    const inputTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
    const outputTokens = Math.ceil(text.length / 4);
    return { text, usage: { inputTokens, outputTokens }, finishReason: 'stop' };
  }
}
