import type { LlmClient, SlotSpec, SlotValue, SlotValues, AgentSpec, InterviewTurn, TriggerPlan } from '../../../packages/agent-builder/src/index';
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

  // --- Conversational builder stubs (deterministic; no Anthropic key) ---

  async interview({ messages }: { messages: InterviewTurn[] }): Promise<{ reply: string; readyToBuild: boolean; buildNow: boolean }> {
    const userTurns = messages.filter((m) => m.role === 'user').length;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const demoNote = ' (Demo — connect an Anthropic key for a real design conversation.)';
    // Explicit "build it" intent (English + Hebrew) → start the build immediately.
    if (/\b(build it|build the agent|that'?s all|that'?s everything|go ahead|create it|let'?s build|deploy|i'?m done)\b/i.test(lastUser) || /בנה|תבנה|צור|תצור|סיים/.test(lastUser)) {
      return { reply: 'On it — building your agent now.' + demoNote, readyToBuild: true, buildNow: true };
    }
    const scripted = [
      'Got it. What should it be able to DO — e.g. web search, calling an external API/webhook, scheduling timed or recurring messages, or looking things up? (or say "none")',
      'Makes sense. Which topics should it stick to, which should it avoid, and when should it hand off to a human?',
      'Last thing — what tone and default language should it use, and what should it be called?',
    ];
    if (userTurns - 1 < scripted.length) return { reply: scripted[userTurns - 1] + demoNote, readyToBuild: false, buildNow: false };
    return { reply: 'Perfect — that\'s enough to design a complete agent. Click "Build the agent" to generate the spec, or keep chatting to refine.' + demoNote, readyToBuild: true, buildNow: false };
  }

  async synthesizeFromConversation({ messages }: { messages: InterviewTurn[] }): Promise<unknown> {
    const userText = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const all = userText.toLowerCase();
    const nameMatch = userText.match(/\b(?:called|named|call it|name it|name is)\s+["']?([A-Za-z0-9][A-Za-z0-9 _-]{0,38})/i);
    const name = (nameMatch ? nameMatch[1] : '').trim() || 'My Agent';
    const goal = (messages.find((m) => m.role === 'user')?.content ?? '').trim().slice(0, 200) || 'help users over WhatsApp';
    const tools: AgentSpec['tools'] = [];
    if (/web ?search|search the web|browse|google|search online/.test(all)) {
      tools.push({ name: 'web_search', description: 'Call this when the user needs current information from the web.', parameters: [{ name: 'query', type: 'string', description: 'Search query.', required: true }], side_effecting: false });
    }
    if (/webhook|external api|call an? api|integration|http request|post to|send (data )?to/.test(all)) {
      tools.push({ name: 'call_webhook', description: 'Call this to send data to an external API/webhook the user configured.', parameters: [{ name: 'payload', type: 'string', description: 'JSON payload to send.', required: true }], side_effecting: true });
    }
    if (/schedul|remind|recurring|every (day|week|morning|hour)|timed|timer|follow.?up|cron/.test(all)) {
      tools.push({ name: 'schedule_message', description: 'Call this to schedule a timed or recurring message/reminder.', parameters: [{ name: 'when', type: 'string', description: 'When to send it (natural language or ISO time).', required: true }, { name: 'message', type: 'string', description: 'The message to send.', required: true }], side_effecting: true });
    }
    if (/look ?up|database|lookup|fetch|retrieve|check (the )?(status|order|account|balance)/.test(all)) {
      tools.push({ name: 'lookup', description: 'Call this to look up records or data for the user.', parameters: [{ name: 'query', type: 'string', description: 'What to look up.', required: true }], side_effecting: false });
    }
    const spec: AgentSpec = {
      version: 1,
      agent_name: name,
      brand_persona: { tone: /formal|professional/.test(all) ? 'formal' : 'friendly', style_notes: 'Be concise and clear — this is a WhatsApp chat.' },
      goal,
      in_scope_topics: [],
      out_of_scope_topics: [],
      refusal_policy: 'Politely decline out-of-scope requests; offer a human handoff.',
      escalation_rules: [{ when: 'the user asks for a human', action: 'handoff' }],
      tools,
      sub_agents: [],
      workflow: { mode: 'single', routes: [], on_no_match: 'default' },
      knowledge_sources: [],
      default_language: /hebrew|עברית/.test(all) ? 'he' : 'en',
      greeting: `Hi! I'm ${name}. How can I help?`,
      fallback_message: "Sorry, I didn't catch that — could you rephrase?",
      model_assignment: 'claude-sonnet-4-6',
      needs_sandbox: tools.some((t) => t.side_effecting),
    };
    return spec;
  }

  // --- Timed-action (trigger) builder stubs (deterministic; no Anthropic key) ---

  async interviewTrigger({ messages }: { spec: AgentSpec; messages: InterviewTurn[] }): Promise<{ reply: string; readyToBuild: boolean; buildNow: boolean }> {
    const userTurns = messages.filter((m) => m.role === 'user').length;
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const demoNote = ' (Demo — connect an Anthropic key for a real action designer.)';
    // Explicit "build it" intent (English + Hebrew) → design the action immediately.
    if (/\b(build it|build the action|that'?s all|go ahead|create it|let'?s build|i'?m done|do it)\b/i.test(lastUser) || /בנה|תבנה|צור|תצור|סיים/.test(lastUser)) {
      return { reply: 'On it — designing this timed action now.' + demoNote, readyToBuild: true, buildNow: true };
    }
    if (userTurns <= 1) {
      return { reply: 'What should the agent do each time it fires, and how often (e.g. "every 1 hour", "every 2 days")?' + demoNote, readyToBuild: false, buildNow: false };
    }
    return { reply: 'Great — that\'s enough. Click "Build this action" to review it, or add more detail.' + demoNote, readyToBuild: true, buildNow: false };
  }

  async synthesizeTrigger({ messages }: { spec: AgentSpec; messages: InterviewTurn[] }): Promise<TriggerPlan> {
    const userText = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const m = userText.match(/every\s+(\d+)\s*(second|minute|hour|day|week)s?/i);
    const value = m ? Math.max(1, Math.min(9999, parseInt(m[1], 10))) : 1;
    const unit = (m ? m[2].toLowerCase() : 'day') as TriggerPlan['unit'];
    const firstUser = messages.find((mm) => mm.role === 'user')?.content ?? 'Timed action';
    const label = firstUser.trim().split(/\s+/).slice(0, 5).join(' ').slice(0, 40) || 'Timed action';
    return { label, prompt: (last || firstUser).trim().slice(0, 400) || 'Send a short update.', value, unit, capabilityRequests: [] };
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

  async reply({ systemPrompt, messages, media, tools, executeToolCall }: { systemPrompt: string; messages: WorkflowRuntimeMessage[]; media?: { kind: 'image' | 'document'; base64: string; mediaType: string; filename?: string }; tools?: unknown; executeToolCall?: unknown }): Promise<{ text: string; usage: { inputTokens: number; outputTokens: number } }> {
    void media; void tools; void executeToolCall; // stub ignores media + tool execution; the live AnthropicWorkflowLlm runs the tool-use loop
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

  async improveInterview({ messages }: { spec: AgentSpec; messages: Array<{ role: 'user' | 'assistant'; content: string }> }): Promise<{ reply: string; proposeKind: ExtensionKind | 'none'; proposeInstruction: string }> {
    const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const demo = ' (demo — connect an Anthropic key for a real improvement chat)';
    if (/\b(add|create|skill|knowledge|info|workflow|sub-?agent|apply|do it|go ahead)\b/i.test(last) || /הוסף|תוסיף|בצע/.test(last)) {
      const kind: ExtensionKind = /skill/i.test(last) ? 'skill' : (/workflow|sub-?agent/i.test(last) ? 'workflow' : 'context');
      return { reply: `Got it — I'll prepare that as a ${kind} change for you to review and approve.` + demo, proposeKind: kind, proposeInstruction: last };
    }
    return { reply: 'Tell me what you would like to improve — for example: information it should know, a new skill, or a new task it should handle.' + demo, proposeKind: 'none', proposeInstruction: '' };
  }
}
