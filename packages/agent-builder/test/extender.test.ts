import { describe, it, expect } from 'vitest';
import { applyExtension } from '../src/extender';
import type { SpecExtension } from '../src/extender';
import { validateAgentSpec } from '../src/validate';
import { checkConsistency } from '../src/consistency';
import { renderInstructions } from '../src/materialize';
import { validSpec } from './fixtures';

describe('applyExtension', () => {
  it('context: appends knowledge, bumps version, stays valid', () => {
    const ext: SpecExtension = { kind: 'context', summary: 'added refund policy', knowledge: [{ type: 'text', label: 'Refunds', content: 'Refunds within 30 days.' }] };
    const next = applyExtension(validSpec, ext);
    expect(next.version).toBe(validSpec.version + 1);
    expect(next.knowledge_sources.some((k) => k.content.includes('30 days'))).toBe(true);
    expect(validateAgentSpec(next).valid).toBe(true);
    expect(checkConsistency(next)).toEqual([]);
    expect(renderInstructions(next)).toContain('Refunds within 30 days.');
  });

  it('skill: adds a skill, injects into the prompt, replaces same-name', () => {
    const ext: SpecExtension = { kind: 'skill', summary: 'booking skill', skill: { name: 'book-demo', description: 'Book a demo. Use when the user wants a demo/meeting.', instructions: 'Ask for a date, then confirm.' } };
    const next = applyExtension(validSpec, ext);
    expect(next.skills?.length).toBe(1);
    expect(validateAgentSpec(next).valid).toBe(true);
    expect(checkConsistency(next)).toEqual([]);
    expect(renderInstructions(next)).toContain('## Skill: book-demo');
    // same name replaces, not duplicates
    const ext2: SpecExtension = { kind: 'skill', summary: 'v2', skill: { name: 'book-demo', description: 'd2', instructions: 'i2' } };
    const next2 = applyExtension(next, ext2);
    expect(next2.skills?.length).toBe(1);
    expect(next2.skills?.[0].instructions).toBe('i2');
  });

  it('workflow: adds sub-agent + route + tool, converts to router, stays consistent', () => {
    const ext: SpecExtension = {
      kind: 'workflow',
      summary: 'add billing area',
      subAgent: { id: 'billing', name: 'Billing', specialty: 'Handle invoices and charges.', tool_names: ['lookup_invoice'] },
      route: { intent: 'billing', description: 'invoices, charges, receipts', target: 'billing' },
      newTools: [{ name: 'lookup_invoice', description: 'Call to fetch an invoice.', parameters: [{ name: 'id', type: 'string', description: 'invoice id', required: true }], side_effecting: false }],
    };
    const next = applyExtension(validSpec, ext);
    expect(next.workflow.mode).toBe('router');
    expect(next.sub_agents.some((s) => s.id === 'billing')).toBe(true);
    expect(next.tools.some((t) => t.name === 'lookup_invoice')).toBe(true);
    expect(next.workflow.routes.some((r) => r.target === 'billing')).toBe(true);
    expect(validateAgentSpec(next).valid).toBe(true);
    expect(checkConsistency(next)).toEqual([]);
  });

  it('catches an inconsistent workflow (route target with no sub-agent / unknown tool)', () => {
    const ext: SpecExtension = {
      kind: 'workflow',
      summary: 'bad',
      subAgent: { id: 'sales', name: 'Sales', specialty: 'x', tool_names: ['ghost_tool'] },
      route: { intent: 'sales', description: 'x', target: 'sales' },
      newTools: [],
    };
    const next = applyExtension(validSpec, ext);
    const issues = checkConsistency(next).map((i) => i.code);
    expect(issues).toContain('subagent_unknown_tool');
  });
});
