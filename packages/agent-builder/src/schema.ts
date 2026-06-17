import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Canonical AgentSpec JSON Schema — single source of truth is `schemas/agent-spec.schema.json`
 * at the repo root, loaded here so the package and the repo never drift.
 * (Path assumes the repo layout; revisit when this package is bundled into LibreChat.)
 */
const schemaPath = fileURLToPath(new URL('../../../schemas/agent-spec.schema.json', import.meta.url));
export const AGENT_SPEC_SCHEMA = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;

export type ModelAssignment = 'claude-sonnet-4-6' | 'claude-opus-4-8' | 'claude-haiku-4-5';

export interface BrandPersona {
  tone: string;
  style_notes: string;
}

export interface EscalationRule {
  when: string;
  action: string;
}

export interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: ToolParameter[];
  side_effecting: boolean;
}

export interface KnowledgeSource {
  type: string;
  label: string;
  content: string;
}

export interface AgentSpec {
  version: number;
  agent_name: string;
  brand_persona: BrandPersona;
  goal: string;
  in_scope_topics: string[];
  out_of_scope_topics: string[];
  refusal_policy: string;
  escalation_rules: EscalationRule[];
  tools: AgentTool[];
  knowledge_sources: KnowledgeSource[];
  default_language: string;
  greeting: string;
  fallback_message: string;
  model_assignment: ModelAssignment;
  needs_sandbox: boolean;
}
