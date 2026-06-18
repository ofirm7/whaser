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
