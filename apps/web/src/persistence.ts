import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoredAgent } from './store';

/**
 * POC persistence: agents (+ their specs, status, listenChats) are written to a gitignored JSON
 * file so they survive a server restart. Production target is MongoDB (see docs/ARCHITECTURE.md).
 * Conversations/transcripts/activity stay in memory.
 *
 * Hardened the same way src/directory.ts is, and for the same reason: every save rewrites the WHOLE
 * file from the in-memory map, so a load that silently returns [] would let the next save
 * PERMANENTLY DELETE every agent on disk. A damaged file is therefore preserved and startup is
 * refused, never papered over. Saves are atomic (tmp + rename) so a crash or a full disk mid-write
 * cannot shred the previous good copy.
 */
const file = fileURLToPath(new URL('../.data/agents.json', import.meta.url));

/** Preserve an unreadable agents.json before we refuse to start, so agents can be recovered by hand. */
function backupCorrupt(raw: string, stamp: number): void {
  try {
    const bak = `${file}.corrupt-${stamp}`;
    writeFileSync(bak, raw);
    console.error(`[persistence] agents.json was unreadable; preserved a copy at ${bak}`);
  } catch {
    /* ignore */
  }
}

export function loadAgents(): StoredAgent[] {
  if (!existsSync(file)) return [];
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    // The file exists but we cannot read it: starting would hand an empty map to the first save.
    throw new Error(`agents.json exists but could not be read (${e instanceof Error ? e.message : String(e)}) — refusing to start so stored agents are not overwritten.`);
  }
  if (!raw.trim()) return [];

  const stamp = Date.now();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    backupCorrupt(raw, stamp);
    throw new Error('agents.json is not valid JSON — refusing to start so stored agents are not overwritten (a copy was preserved).');
  }

  const records = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Object.values(parsed as Record<string, unknown>) // recover a `{"0":{…},"1":{…}}` shape rather than wiping
      : null;
  if (!records) {
    backupCorrupt(raw, stamp);
    throw new Error('agents.json has an unexpected shape — refusing to start so stored agents are not overwritten (a copy was preserved).');
  }

  const isAgent = (a: unknown): a is StoredAgent =>
    !!a && typeof a === 'object' &&
    typeof (a as StoredAgent).id === 'string' &&
    typeof (a as StoredAgent).tenantId === 'string' &&
    typeof (a as StoredAgent).phoneNumberId === 'string' &&
    !!(a as StoredAgent).spec;
  const valid = records.filter(isAgent);
  if (records.length > 0 && valid.length === 0) {
    backupCorrupt(raw, stamp);
    throw new Error('agents.json contained no valid agent records — refusing to start so agents are not lost (a copy was preserved).');
  }
  if (valid.length !== records.length) backupCorrupt(raw, stamp); // some odd records dropped — keep the original around

  return valid;
}

export function saveAgents(agents: StoredAgent[]): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Atomic replace: a half-written file never becomes the live one.
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(agents, null, 2));
    renameSync(tmp, file);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    // Loud: a silent save failure is how agents disappear without a trace.
    console.error('[persistence] FAILED to save agents.json — changes are in memory only:', e);
    throw e;
  }
}
