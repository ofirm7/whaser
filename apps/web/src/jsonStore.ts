import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A tenantId → record JSON file, hardened like persistence.ts: every save rewrites the WHOLE file from
 * memory, so a store that silently loaded as {} would let the next save wipe every workspace's saved
 * credentials (Google tokens, WhatsApp number assignments). A damaged file is therefore preserved
 * (copied beside it) and the store goes read-only — saves throw — instead of being papered over; the
 * rest of the app keeps running. Odd records are dropped but the original file is kept. Saves are
 * atomic (tmp + rename), owner-only (secrets, refresh tokens), and a failed save throws without
 * changing memory.
 */
export class JsonStore<T> {
  data: Record<string, T> = {};
  /** Why saving is refused (the file on disk couldn't be trusted), or null. Logged in full at startup. */
  readonly locked: string | null;

  /** `what` names the contents in messages ("Google account links"); `tag` prefixes log lines. */
  constructor(private readonly file: string, private readonly what: string, isRecord: (r: unknown) => boolean, private readonly tag: string) {
    this.locked = this.load(isRecord);
    if (this.locked) console.error(`[${tag}] ${this.locked} — refusing to save the ${what} until it's fixed (then restart).`);
  }

  private load(isRecord: (r: unknown) => boolean): string | null {
    if (!existsSync(this.file)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (e) {
      return `${this.file} exists but couldn't be read (${e instanceof Error ? e.message : String(e)})`;
    }
    if (!raw.trim()) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return `${this.file} isn't valid JSON; a copy was preserved at ${this.preserve(raw)}`;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return `${this.file} has an unexpected shape; a copy was preserved at ${this.preserve(raw)}`;
    const entries = Object.entries(parsed as Record<string, unknown>);
    const good = entries.filter(([, r]) => isRecord(r));
    if (entries.length && !good.length) return `${this.file} has no valid records; a copy was preserved at ${this.preserve(raw)}`;
    if (good.length !== entries.length) console.error(`[${this.tag}] dropped ${entries.length - good.length} unreadable record(s) from the ${this.what}; original preserved at ${this.preserve(raw)}`);
    this.data = Object.fromEntries(good) as Record<string, T>;
    return null;
  }

  private preserve(raw: string): string {
    const bak = `${this.file}.corrupt-${Date.now()}`;
    try {
      writeFileSync(bak, raw, { mode: 0o600 });
    } catch {
      /* best effort */
    }
    return bak;
  }

  /** Write `next` (default: the current data) and only then make it the in-memory state. */
  save(next: Record<string, T> = this.data): void {
    if (this.locked) throw new Error(`Whaser couldn't read its saved ${this.what}, so it won't overwrite it. An admin needs to check the server log, fix the file and restart.`);
    const tmp = `${this.file}.tmp`;
    try {
      const dir = dirname(this.file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
      console.error(`[${this.tag}] FAILED to save the ${this.what}:`, e);
      throw new Error(`Couldn't save the ${this.what} on the server.`);
    }
    this.data = next;
  }
}

/** `data` without one tenant's record. */
export function without<T>(data: Record<string, T>, tenantId: string): Record<string, T> {
  const { [tenantId]: _gone, ...rest } = data;
  return rest;
}
