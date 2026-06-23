import { describe, it, expect } from 'vitest';
import { WorkflowEngine, composeSystemPrompt } from '../src/workflow';
import type { WorkflowLlm } from '../src/workflow';
import type { AgentSpec, AgentTool } from '../src/schema';
import { validSpec } from './fixtures';

const ambientTool: AgentTool = {
  name: 'chat_history',
  description: 'Read earlier messages in this chat.',
  parameters: [{ name: 'query', type: 'string', description: 'keyword', required: false }],
  side_effecting: false,
};

/** An LLM seam that records the `tools` list handed to reply() (for ambient-tool assertions). */
function llmRecordingTools(classify: string | null = null) {
  const toolLists: Array<Array<{ name: string }> | undefined> = [];
  const llm: WorkflowLlm = {
    async classifyIntent() { return classify; },
    async reply({ tools }) {
      toolLists.push(tools?.map((t) => ({ name: t.name })));
      return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return { llm, toolLists };
}

const routerSpec: AgentSpec = {
  ...validSpec,
  sub_agents: [
    { id: 'sales', name: 'Sales', specialty: 'Answer pricing and book demos.', tool_names: ['lookup_plan'] },
    { id: 'support', name: 'Support', specialty: 'Help with existing accounts.', tool_names: [] },
  ],
  workflow: {
    mode: 'router',
    routes: [
      { intent: 'pricing', description: 'questions about price/plans/demos', target: 'sales' },
      { intent: 'help', description: 'help with an existing account', target: 'support' },
    ],
    on_no_match: 'handoff',
  },
};

function llmWith(classify: string | null) {
  const systems: string[] = [];
  const calls = { classify: 0 };
  const llm: WorkflowLlm = {
    async classifyIntent() {
      calls.classify++;
      return classify;
    },
    async reply({ systemPrompt }) {
      systems.push(systemPrompt);
      return { text: 'ok', usage: { inputTokens: 5, outputTokens: 2 } };
    },
  };
  return { llm, systems, calls };
}

describe('WorkflowEngine', () => {
  it('routes a matched intent to its sub-agent and composes its specialty', async () => {
    const h = llmWith('pricing');
    const r = await new WorkflowEngine(routerSpec, h.llm).handle([{ role: 'user', content: 'how much is the pro plan?' }]);
    expect(r.routedTo).toBe('sales');
    expect(h.systems[0]).toContain('"Sales" specialist');
    expect(h.systems[0]).toContain('lookup_plan');
  });

  it('hands off when no route matches and on_no_match=handoff', async () => {
    const h = llmWith(null);
    const r = await new WorkflowEngine(routerSpec, h.llm).handle([{ role: 'user', content: 'weather?' }]);
    expect(r.routedTo).toBe('handoff');
    expect(r.text.toLowerCase()).toContain('human');
    expect(h.systems).toHaveLength(0); // no reply call on handoff
  });

  it('falls back to the default agent when on_no_match=default', async () => {
    const spec = { ...routerSpec, workflow: { ...routerSpec.workflow, on_no_match: 'default' as const } };
    const h = llmWith(null);
    const r = await new WorkflowEngine(spec, h.llm).handle([{ role: 'user', content: 'hi' }]);
    expect(r.routedTo).toBe('default');
    expect(h.systems[0]).not.toContain('specialist');
  });

  it('single mode answers directly without classifying', async () => {
    const h = llmWith('pricing');
    const r = await new WorkflowEngine(validSpec, h.llm).handle([{ role: 'user', content: 'hi' }]);
    expect(r.routedTo).toBe('default');
    expect(h.calls.classify).toBe(0);
  });

  it('appends ambient tools to the declared tool list when an executor is present', async () => {
    const h = llmRecordingTools();
    await new WorkflowEngine(validSpec, h.llm).handle(
      [{ role: 'user', content: 'hi' }],
      undefined,
      async () => 'tool output',
      [ambientTool],
    );
    const names = (h.toolLists[0] ?? []).map((t) => t.name);
    expect(names).toContain('lookup_plan'); // the spec's declared tool
    expect(names).toContain('chat_history'); // the ambient built-in
  });

  it('keeps ambient tools reachable on a routed sub-agent whose allow-list excludes them', async () => {
    const h = llmRecordingTools('pricing'); // routes to "sales", tool_names: ['lookup_plan'] only
    await new WorkflowEngine(routerSpec, h.llm).handle(
      [{ role: 'user', content: 'how much is pro?' }],
      undefined,
      async () => 'tool output',
      [ambientTool],
    );
    const names = (h.toolLists[0] ?? []).map((t) => t.name);
    expect(names).toContain('lookup_plan'); // the sub-agent's one allowed tool
    expect(names).toContain('chat_history'); // ambient — present despite not being in tool_names
  });

  it('offers no tools at all (ambient included) when there is no executor', async () => {
    const h = llmRecordingTools();
    await new WorkflowEngine(validSpec, h.llm).handle([{ role: 'user', content: 'hi' }], undefined, undefined, [ambientTool]);
    expect(h.toolLists[0]).toBeUndefined();
  });

  it('composeSystemPrompt includes sub-agent specialty + tools', () => {
    const s = composeSystemPrompt(routerSpec, routerSpec.sub_agents[0]);
    expect(s).toContain('Sales');
    expect(s).toContain('book demos');
    expect(s).toContain('lookup_plan');
  });
});
