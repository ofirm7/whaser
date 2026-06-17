import { describe, it, expect } from 'vitest';
import { toLibreChatAgent, renderInstructions } from '../src/materialize';
import { validSpec } from './fixtures';

describe('materialize', () => {
  it('renders an instructions block from the spec', () => {
    const ins = renderInstructions(validSpec);
    expect(ins).toContain('Acme Support');
    expect(ins).toContain('Primary goal: Answer pre-sales questions and book demos.');
    expect(ins).toContain('In scope: pricing; features.');
    expect(ins).toContain('Out of scope: legal advice.');
    expect(ins).toContain('handoff');
    expect(ins).toContain('Hours: 9-5 weekdays.');
  });

  it('maps the spec onto a LibreChat agent payload', () => {
    const agent = toLibreChatAgent(validSpec);
    expect(agent.name).toBe('Acme Support');
    expect(agent.provider).toBe('anthropic');
    expect(agent.model).toBe('claude-sonnet-4-6');
    expect(agent.tools.map((t) => t.name)).toEqual(['lookup_plan']);
    expect(agent.metadata.whaser).toEqual({
      specVersion: 1,
      sideEffectingTools: [],
      needsSandbox: false,
      defaultLanguage: 'en',
    });
  });

  it('lists side-effecting tools and sandbox flag', () => {
    const spec = {
      ...validSpec,
      needs_sandbox: true,
      tools: [{ ...validSpec.tools[0], name: 'book_demo', side_effecting: true }],
    };
    const agent = toLibreChatAgent(spec);
    expect(agent.metadata.whaser.sideEffectingTools).toEqual(['book_demo']);
    expect(agent.metadata.whaser.needsSandbox).toBe(true);
  });
});
