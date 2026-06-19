import type { LlmClient, SlotSpec, SlotValue, SlotValues, AgentSpec } from '../../../packages/agent-builder/src/index';
import type { WorkflowLlm, WorkflowRuntimeMessage } from '../../../packages/agent-builder/src/index';
import type { Tuner, TranscriptTurn, TuningResult, TuningSuggestion } from '../../../packages/agent-builder/src/index';
import type { Extender, ExtensionKind, SpecExtension } from '../../../packages/agent-builder/src/index';

const asList = (v: SlotValue | undefined): string[] => (Array.isArray(v) ? v : []);
const asText = (v: SlotValue | undefined): string => (typeof v === 'string' ? v : '');

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'item';
}

const NONE = /^\s*(none|no|n\/a|na|nothing|skip)\s*$/i;

/** Deterministic stand-in for AnthropicLlmClient — the wizard runs with no Anthropic key. */
export class StubLlmClient implements LlmClient {
  async extractSlot({ slot, userText }: { slot: SlotSpec; userText: string }): Promise<SlotValue> {
    if (slot.kind === 'list') {
      if (NONE.test(userText)) return [];
      return userText.split(/[,;]| and /i).map((s) => s.trim()).filter((s) => s.length > 0);
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
      return { name: n, description: `Call this when the user needs: ${t}.`, parameters: [], side_effecting: false };
    });
    const knowledge = asList(values.knowledge_sources).map((k, i) => ({ type: 'text', label: `source_${i + 1}`, content: k }));
    const lang = /eng/i.test(asText(values.default_language)) ? 'en' : asText(values.default_language) || 'en';

    // WAT: ≥2 in-scope areas → a router workflow with one sub-agent per area.
    const seen = new Set<string>();
    const subAgents = inScope
      .map((topic) => ({ id: slugify(topic), name: topic, specialty: `Handle questions about ${topic}.`, tool_names: [] as string[] }))
      .filter((sa) => (seen.has(sa.id) ? false : (seen.add(sa.id), true)));
    const router = subAgents.length >= 2;
    const workflow = router
      ? {
          mode: 'router' as const,
          routes: subAgents.map((sa) => ({ intent: sa.id, description: `Questions about ${sa.name}`, target: sa.id })),
          on_no_match: 'default' as const,
        }
      : { mode: 'single' as const, routes: [], on_no_match: 'default' as const };

    const spec: AgentSpec = {
      version: 1,
      agent_name: name,
      brand_persona: { tone: asText(values.tone) || 'friendly', style_notes: 'Be concise and clear — this is a WhatsApp chat.' },
      goal,
      in_scope_topics: inScope,
      out_of_scope_topics: outScope,
      refusal_policy: inScope.length ? `Politely decline anything outside ${inScope.join(', ')}; offer a human handoff.` : 'Politely decline out-of-scope requests; offer a human handoff.',
      escalation_rules: [{ when: asText(values.escalation) || 'the user asks for a human', action: 'handoff' }],
      tools,
      sub_agents: router ? subAgents : [],
      workflow,
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
 * Deterministic stand-in for the WAT engine's LLM — keyword routing + a canned in-persona reply,
 * so the simulator works with no Anthropic key. In production this is the Claude-backed WorkflowLlm.
 */
export class StubWorkflowLlm implements WorkflowLlm {
  async classifyIntent({ message, routes }: { message: string; routes: Array<{ intent: string; description: string }> }): Promise<string | null> {
    const lower = message.toLowerCase();
    for (const r of routes) {
      const keywords = `${r.intent} ${r.description}`
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((k) => k.length > 3);
      if (keywords.some((k) => lower.includes(k))) return r.intent;
    }
    return null;
  }

  async reply({ systemPrompt, messages }: { systemPrompt: string; messages: WorkflowRuntimeMessage[] }): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
    const hasPrior = messages.some((m) => m.role === 'assistant');
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    let text: string;
    if (!hasPrior) {
      const g = systemPrompt.match(/Greeting:\s*(.+)/);
      text = g ? g[1].trim() : 'Hi! How can I help?';
    } else {
      const sp = systemPrompt.match(/"([^"]+)" specialist/);
      const who = sp ? ` ${sp[1]} specialist here.` : '';
      text = `(demo)${who} You said: “${lastUser}”. Connect an Anthropic key for real answers.`;
    }
    const inputTokens = Math.ceil((systemPrompt.length + messages.reduce((n, m) => n + m.content.length, 0)) / 4);
    return { text, usage: { inputTokens, outputTokens: Math.ceil(text.length / 4) } };
  }
}

/**
 * Deterministic stand-in for the Claude tuner — proposes plausible spec edits from transcripts
 * without a key. Production uses AnthropicTuner.
 */
export class StubTuner implements Tuner {
  async suggest({ spec, transcripts, instruction }: { spec: AgentSpec; transcripts: TranscriptTurn[]; instruction?: string }): Promise<TuningResult> {
    const userMsgs = transcripts.filter((t) => t.role === 'user').map((t) => t.content.trim()).filter(Boolean);
    const suggestions: TuningSuggestion[] = [];
    const guide = (instruction ?? '').trim();
    if (guide) {
      suggestions.push({ kind: 'add_knowledge', label: 'Owner guidance', value: guide, rationale: 'Owner-requested improvement (demo: connect an Anthropic key for smarter edits).' });
    }
    if (userMsgs.length) {
      suggestions.push({
        kind: 'add_knowledge',
        label: 'Recent FAQ',
        value: `Q: "${userMsgs[userMsgs.length - 1]}" — add the answer here.`,
        rationale: 'A recent user question worth documenting as a knowledge source.',
      });
    }
    const oos = userMsgs.find((m) => /refund|cancel|complain/i.test(m));
    if (oos && !spec.out_of_scope_topics.some((t) => /refund/i.test(t))) {
      suggestions.push({ kind: 'add_out_of_scope', label: '', value: 'refunds', rationale: `A user asked "${oos}", which looks out of scope.` });
    }
    return {
      summary: `Reviewed ${transcripts.length} messages; ${suggestions.length} suggestion(s). (demo heuristic — connect an Anthropic key for richer analysis.)`,
      suggestions,
    };
  }
}

/** Deterministic stand-in for AnthropicExtender — drafts a plausible extension with no key. */
export class StubExtender implements Extender {
  async propose({ kind, instruction, prior }: { spec: AgentSpec; kind: ExtensionKind; instruction: string; prior?: SpecExtension | null }): Promise<SpecExtension> {
    const text = ((prior ? instruction + ' (revised)' : instruction) || 'new item').trim();
    if (kind === 'context') {
      return { kind: 'context', summary: 'Add 1 knowledge note (demo heuristic — connect an Anthropic key for richer drafting).', knowledge: [{ type: 'text', label: 'Note', content: text }] };
    }
    if (kind === 'skill') {
      const name = (slugify(text).replace(/_/g, '-').slice(0, 30)) || 'custom-skill';
      return {
        kind: 'skill',
        summary: `Draft skill "${name}" (demo).`,
        skill: {
          name,
          description: `${text}. Use this whenever the user needs help with: ${text}.`,
          instructions: `# ${name}\n\nWhen this applies:\n1. Understand the user's request about ${text}.\n2. Help step by step.\n3. Confirm before any action.`,
        },
      };
    }
    const id = (slugify(text).replace(/_/g, '-').slice(0, 30)) || 'new-area';
    return {
      kind: 'workflow',
      summary: `Add sub-agent "${id}" (demo).`,
      subAgent: { id, name: text.slice(0, 30) || id, specialty: `Handle: ${text}.`, tool_names: [] },
      route: { intent: id, description: `Questions about ${text}`, target: id },
      newTools: [],
    };
  }
}
