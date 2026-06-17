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
      input_schema: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'], additionalProperties: false },
      side_effecting: false,
    },
  ],
  knowledge_sources: [{ type: 'text', label: 'FAQ', content: 'Hours: 9-5 weekdays.' }],
  default_language: 'en',
  greeting: "Hi! I'm Acme's assistant — how can I help?",
  fallback_message: "Sorry, I didn't catch that. Could you rephrase?",
  model_assignment: 'claude-sonnet-4-6',
  needs_sandbox: false,
};
