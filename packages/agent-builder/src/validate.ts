import Ajv2020 from 'ajv/dist/2020';
import { AGENT_SPEC_SCHEMA } from './schema';

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validator = ajv.compile(AGENT_SPEC_SCHEMA);

export interface SchemaValidation {
  valid: boolean;
  errors: string[];
}

/** Validate a synthesized object against the canonical AgentSpec JSON Schema. */
export function validateAgentSpec(obj: unknown): SchemaValidation {
  const valid = validator(obj) as boolean;
  if (valid) return { valid: true, errors: [] };
  const errors = (validator.errors ?? []).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`);
  return { valid: false, errors };
}
