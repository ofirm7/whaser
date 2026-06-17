import { describe, it, expect } from 'vitest';
import { validateAgentSpec } from '../src/validate';
import { AGENT_SPEC_SCHEMA } from '../src/schema';
import { validSpec } from './fixtures';

describe('validateAgentSpec', () => {
  it('loads the canonical schema with all 15 required fields', () => {
    expect((AGENT_SPEC_SCHEMA as { required: string[] }).required).toHaveLength(15);
  });

  it('accepts a valid spec', () => {
    expect(validateAgentSpec(validSpec)).toEqual({ valid: true, errors: [] });
  });

  it('rejects a missing required field', () => {
    const { goal, ...rest } = validSpec;
    void goal;
    const r = validateAgentSpec(rest);
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/goal/);
  });

  it('rejects an unknown property (additionalProperties:false)', () => {
    const r = validateAgentSpec({ ...validSpec, surprise: true });
    expect(r.valid).toBe(false);
  });

  it('rejects a bad model_assignment enum', () => {
    const r = validateAgentSpec({ ...validSpec, model_assignment: 'gpt-4' });
    expect(r.valid).toBe(false);
  });
});
