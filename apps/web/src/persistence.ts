import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoredAgent } from './store';

/**
 * POC persistence: agents (+ their specs, status, listenChats) are written to a gitignored JSON
 * file so they survive a server restart. Production target is MongoDB (see docs/ARCHITECTURE.md).
 * Conversations/transcripts/activity stay in memory.
 */
const file = fileURLToPath(new URL('../.data/agents.json', import.meta.url));

export function loadAgents(): StoredAgent[] {
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(data) ? (data as StoredAgent[]) : [];
  } catch {
    return [];
  }
}

export function saveAgents(agents: StoredAgent[]): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(agents, null, 2));
}
