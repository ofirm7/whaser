import type { AgentSpec } from './schema';

export type ConsistencyCode =
  | 'scope_overlap'
  | 'goal_empty'
  | 'tool_unnamed'
  | 'tool_duplicate'
  | 'tool_no_executor'
  | 'greeting_empty'
  | 'fallback_empty'
  | 'router_no_routes'
  | 'route_unknown_target'
  | 'subagent_duplicate_id'
  | 'subagent_unknown_tool'
  | 'skill_unnamed'
  | 'skill_duplicate';

export interface ConsistencyIssue {
  code: ConsistencyCode;
  message: string;
}

const norm = (s: string): string => s.trim().toLowerCase();

/**
 * Programmatic checks that a schema-valid AgentSpec is also USABLE (the gap a JSON schema can't
 * catch). `knownExecutors`, when provided, flags tools the runtime has no executor for.
 */
export function checkConsistency(spec: AgentSpec, opts?: { knownExecutors?: string[] }): ConsistencyIssue[] {
  const issues: ConsistencyIssue[] = [];

  const inScope = new Set(spec.in_scope_topics.map(norm));
  const overlap = spec.out_of_scope_topics.filter((t) => inScope.has(norm(t)));
  if (overlap.length) {
    issues.push({ code: 'scope_overlap', message: `in/out-of-scope topics overlap: ${overlap.join(', ')}` });
  }

  if (!spec.goal.trim()) issues.push({ code: 'goal_empty', message: 'goal must not be empty' });
  if (!spec.greeting.trim()) issues.push({ code: 'greeting_empty', message: 'greeting must not be empty' });
  if (!spec.fallback_message.trim()) issues.push({ code: 'fallback_empty', message: 'fallback_message must not be empty' });

  const seen = new Set<string>();
  const known = opts?.knownExecutors ? new Set(opts.knownExecutors.map(norm)) : null;
  for (const tool of spec.tools) {
    const name = tool.name?.trim();
    if (!name) {
      issues.push({ code: 'tool_unnamed', message: 'every tool needs a name' });
      continue;
    }
    if (seen.has(norm(name))) {
      issues.push({ code: 'tool_duplicate', message: `duplicate tool name: ${name}` });
    }
    seen.add(norm(name));
    if (known && !known.has(norm(name))) {
      issues.push({ code: 'tool_no_executor', message: `tool "${name}" has no registered executor` });
    }
  }

  // WAT: sub-agents + workflow routing must be coherent.
  const toolNames = new Set(spec.tools.map((t) => norm(t.name)));
  const subAgentIds = new Set<string>();
  for (const sa of spec.sub_agents) {
    if (subAgentIds.has(sa.id)) issues.push({ code: 'subagent_duplicate_id', message: `duplicate sub-agent id: ${sa.id}` });
    subAgentIds.add(sa.id);
    for (const tn of sa.tool_names) {
      if (!toolNames.has(norm(tn))) {
        issues.push({ code: 'subagent_unknown_tool', message: `sub-agent "${sa.id}" references unknown tool "${tn}"` });
      }
    }
  }
  if (spec.workflow.mode === 'router') {
    if (spec.workflow.routes.length === 0) {
      issues.push({ code: 'router_no_routes', message: 'router workflow has no routes' });
    }
    for (const r of spec.workflow.routes) {
      if (!subAgentIds.has(r.target)) {
        issues.push({ code: 'route_unknown_target', message: `route "${r.intent}" targets unknown sub-agent "${r.target}"` });
      }
    }
  }

  // Skills (optional): names must be present + unique.
  const skillNames = new Set<string>();
  for (const sk of spec.skills ?? []) {
    const n = sk.name?.trim();
    if (!n) {
      issues.push({ code: 'skill_unnamed', message: 'every skill needs a name' });
      continue;
    }
    if (skillNames.has(norm(n))) issues.push({ code: 'skill_duplicate', message: `duplicate skill name: ${n}` });
    skillNames.add(norm(n));
  }

  return issues;
}
