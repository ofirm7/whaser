import { describe, it, expect } from 'vitest';
import { checkConsistency } from '../src/consistency';
import { validSpec } from './fixtures';

const codes = (spec: Parameters<typeof checkConsistency>[0], opts?: Parameters<typeof checkConsistency>[1]) =>
  checkConsistency(spec, opts).map((i) => i.code);

describe('checkConsistency', () => {
  it('passes a clean spec', () => {
    expect(checkConsistency(validSpec)).toEqual([]);
  });

  it('flags overlapping in/out-of-scope topics (case-insensitive)', () => {
    expect(codes({ ...validSpec, out_of_scope_topics: ['Pricing'] })).toContain('scope_overlap');
  });

  it('flags duplicate and unnamed tools', () => {
    const dup = { ...validSpec, tools: [validSpec.tools[0], { ...validSpec.tools[0] }] };
    expect(codes(dup)).toContain('tool_duplicate');
    const unnamed = { ...validSpec, tools: [{ ...validSpec.tools[0], name: '' }] };
    expect(codes(unnamed)).toContain('tool_unnamed');
  });

  it('flags tools with no registered executor when knownExecutors is given', () => {
    expect(codes(validSpec, { knownExecutors: ['something_else'] })).toContain('tool_no_executor');
    expect(codes(validSpec, { knownExecutors: ['lookup_plan'] })).not.toContain('tool_no_executor');
  });

  it('flags empty goal / greeting / fallback', () => {
    expect(codes({ ...validSpec, greeting: '   ' })).toContain('greeting_empty');
    expect(codes({ ...validSpec, fallback_message: '' })).toContain('fallback_empty');
    expect(codes({ ...validSpec, goal: '' })).toContain('goal_empty');
  });

  it('flags WAT routing problems', () => {
    const withSub = {
      ...validSpec,
      sub_agents: [{ id: 'sales', name: 'Sales', specialty: 'pricing', tool_names: ['lookup_plan'] }],
    };
    // route points at a non-existent sub-agent
    expect(
      codes({ ...withSub, workflow: { mode: 'router' as const, routes: [{ intent: 'p', description: 'd', target: 'ghost' }], on_no_match: 'default' as const } }),
    ).toContain('route_unknown_target');
    // router with no routes
    expect(codes({ ...withSub, workflow: { mode: 'router' as const, routes: [], on_no_match: 'default' as const } })).toContain('router_no_routes');
    // sub-agent references a tool that isn't defined
    expect(
      codes({ ...validSpec, sub_agents: [{ id: 's', name: 'S', specialty: 'x', tool_names: ['ghost_tool'] }] }),
    ).toContain('subagent_unknown_tool');
  });
});
