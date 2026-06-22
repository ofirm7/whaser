/**
 * Validates every agents-catalog seed file in apps/web/catalog/*.json against the AgentSpec schema
 * and the consistency rules — the same checks AppState.loadCatalog() runs at startup, but as a hard
 * gate (exits non-zero on any failure). Run via `npm run catalog:validate`.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateAgentSpec, checkConsistency } from '../../../packages/agent-builder/src/index';

const META = ['id', 'title', 'description', 'category'] as const;

function validateFile(dir: string, file: string): string[] {
  const stem = file.replace(/\.json$/, '');
  const errors: string[] = [];
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    return [`not valid JSON: ${e instanceof Error ? e.message : String(e)}`];
  }
  for (const k of META) {
    if (typeof entry[k] !== 'string' || !(entry[k] as string).trim()) errors.push(`missing/empty "${k}"`);
  }
  if (entry.id !== stem) errors.push(`id "${String(entry.id)}" must equal filename stem "${stem}"`);
  const schema = validateAgentSpec(entry.spec);
  if (!schema.valid) {
    errors.push(`invalid spec: ${schema.errors.join('; ')}`);
  } else {
    const issues = checkConsistency(entry.spec as Parameters<typeof checkConsistency>[0]);
    for (const i of issues) errors.push(`inconsistent: ${i.message}`);
  }
  // Optional catalog-shipped scheduled triggers (seeded onto the agent on deploy).
  if (entry.triggers !== undefined) {
    if (!Array.isArray(entry.triggers)) {
      errors.push('"triggers" must be an array');
    } else {
      const UNITS = ['second', 'minute', 'hour', 'day', 'week'];
      entry.triggers.forEach((t, i) => {
        const tg = t as Record<string, unknown>;
        if (typeof tg.label !== 'string' || !tg.label.trim()) errors.push(`trigger[${i}]: missing/empty "label"`);
        if (typeof tg.prompt !== 'string' || !tg.prompt.trim()) errors.push(`trigger[${i}]: missing/empty "prompt"`);
        if (typeof tg.value !== 'number' || !Number.isFinite(tg.value) || tg.value <= 0) errors.push(`trigger[${i}]: "value" must be a positive number`);
        if (typeof tg.unit !== 'string' || !UNITS.includes(tg.unit)) errors.push(`trigger[${i}]: "unit" must be one of ${UNITS.join(', ')}`);
        if (tg.enabled !== undefined && typeof tg.enabled !== 'boolean') errors.push(`trigger[${i}]: "enabled" must be a boolean`);
      });
    }
  }
  return errors;
}

const dir = fileURLToPath(new URL('../catalog', import.meta.url));
if (!existsSync(dir)) {
  console.error(`No catalog directory at ${dir}`);
  process.exit(1);
}

const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
const seenIds = new Set<string>();
let failed = 0;

for (const file of files) {
  const stem = file.replace(/\.json$/, '');
  const errors = validateFile(dir, file);
  if (seenIds.has(stem)) errors.push(`duplicate catalog id "${stem}"`);
  seenIds.add(stem);
  if (errors.length) {
    failed++;
    console.error(`FAIL ${file}\n  - ${errors.join('\n  - ')}`);
  } else {
    console.log(`PASS ${file}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} catalog entries valid.`);
process.exit(failed ? 1 : 0);
