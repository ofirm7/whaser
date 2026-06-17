import type { AgentSpec } from '../src/schema';

export const validSpec: AgentSpec = {
  version: 1,
  agent_name: 'Acme Support',
  brand_persona: { tone: 'friendly', style_notes: 'concise, no emojis' },
  goal: 'Answer pre-sales questions and book demos.',
  in_scope_topics: ['pricing', 'features'],
  out_of_scope_topics: ['legal advice'],
  refusal_policy: 'Politely decline out-of-scope; offer human handoff.',
  escalation_rules: [{ when: 'user asks for a human', action: 'handoff' }],
  tools: [
    {
      name: 'lookup_plan',
      description: 'Call when the user asks about a plan price or limits.',
      parameters: [{ name: 'plan', type: 'string', description: 'The plan name', required: true }],
      side_effecting: false,
    },
  ],
  sub_agents: [],
  workflow: { mode: 'single', routes: [], on_no_match: 'default' },
  knowledge_sources: [{ type: 'text', label: 'FAQ', content: 'Hours: 9-5 weekdays.' }],
  default_language: 'en',
  greeting: "Hi! I'm Acme's assistant — how can I help?",
  fallback_message: "Sorry, I didn't catch that. Could you rephrase?",
  model_assignment: 'claude-sonnet-4-6',
  needs_sandbox: false,
};
