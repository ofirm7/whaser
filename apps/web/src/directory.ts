/**
 * User directory. Real sign-up: users persist to .data/users.json with a scrypt password hash +
 * per-user salt. Each registered user gets their OWN tenant (isolation: agents + WhatsApp).
 *
 * Security: hashing on the request path is async (never blocks the event loop). Demo accounts
 * (alice/bob/carol) are seeded with RANDOM passwords written to .data/seed-credentials.txt (never
 * the old public "password") so a demo login can't expose a real account's linked WhatsApp.
 */
import { scrypt, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scryptAsync = promisify(scrypt) as (pw: string, salt: string, len: number) => Promise<Buffer>;

export interface DirectoryUser {
  username: string;
  displayName: string;
  tenantId: string;
  tenantName: string;
  role: 'admin' | 'user';
  salt: string;
  hash: string;
}

const file = fileURLToPath(new URL('../.data/users.json', import.meta.url));
const credsFile = fileURLToPath(new URL('../.data/seed-credentials.txt', import.meta.url));

const hashSeed = (password: string, salt: string): string => scryptSync(password, salt, 64).toString('hex');
const hashPw = async (password: string, salt: string): Promise<string> => (await scryptAsync(password, salt, 64)).toString('hex');

/** Preserve an unreadable users.json before we refuse to start, so accounts can be recovered by hand. */
function backupCorrupt(raw: string): void {
  try {
    const bak = `${file}.corrupt-${Date.now()}`;
    writeFileSync(bak, raw);
    console.error(`[directory] users.json was unreadable; preserved a copy at ${bak}`);
  } catch {
    /* ignore */
  }
}

/**
 * Load the user directory. Hardened so a malformed file can NEVER silently become "no users" — which
 * would let the demo-seed step overwrite (and permanently delete) real accounts:
 *  - missing/empty file -> [] (first run; safe to seed).
 *  - valid array -> use it.
 *  - object-of-records (a legacy/buggy `{"0":{…}}` shape) -> recover via Object.values instead of wiping.
 *  - unparseable / wrong-shape / zero valid records from a non-empty file -> back up + THROW (refuse to
 *    start) so the existing file is never overwritten with demo-only data.
 */
function load(): DirectoryUser[] {
  if (!existsSync(file)) return [];
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return []; // unreadable on disk (e.g. perms) — treat as first run rather than crash; nothing to overwrite yet
  }
  if (!raw.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    backupCorrupt(raw);
    throw new Error('users.json is not valid JSON — refusing to start so existing accounts are not overwritten (a copy was preserved).');
  }

  const records = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Object.values(parsed as Record<string, unknown>) // recover a `{"0":{…},"1":{…}}` shape rather than wiping
      : null;
  if (!records) {
    backupCorrupt(raw);
    throw new Error('users.json has an unexpected shape — refusing to start so existing accounts are not overwritten (a copy was preserved).');
  }

  const isUser = (u: unknown): u is DirectoryUser =>
    !!u && typeof u === 'object' &&
    typeof (u as DirectoryUser).username === 'string' &&
    typeof (u as DirectoryUser).hash === 'string' &&
    typeof (u as DirectoryUser).salt === 'string';
  const valid = records.filter(isUser);
  if (records.length > 0 && valid.length === 0) {
    backupCorrupt(raw);
    throw new Error('users.json contained no valid user records — refusing to start so accounts are not lost (a copy was preserved).');
  }
  if (valid.length !== records.length) backupCorrupt(raw); // some odd records dropped — keep the original around

  return valid;
}

function saveUsers(): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(users, null, 2));
}

const users: DirectoryUser[] = load();

// Seed demo accounts with RANDOM passwords; rotate any that still use the legacy public "password".
(function seed() {
  const demo: Array<[string, string, string, string, 'admin' | 'user']> = [
    ['alice', 'Alice', 'acme', 'Acme Inc.', 'admin'],
    ['bob', 'Bob', 'acme', 'Acme Inc.', 'user'],
    ['carol', 'Carol', 'globex', 'Globex Corp.', 'admin'],
  ];
  const issued: Array<[string, string]> = [];
  let changed = false;
  for (const [username, displayName, tenantId, tenantName, role] of demo) {
    const existing = users.find((u) => u.username === username);
    const usesPublicDefault = existing && existing.hash === hashSeed('password', existing.salt);
    if (!existing || usesPublicDefault) {
      const pw = randomBytes(9).toString('base64url');
      const salt = randomBytes(16).toString('hex');
      const rec: DirectoryUser = { username, displayName, tenantId, tenantName, role, salt, hash: hashSeed(pw, salt) };
      if (existing) Object.assign(existing, rec);
      else users.push(rec);
      issued.push([username, pw]);
      changed = true;
    }
  }
  if (changed) {
    saveUsers();
    try {
      writeFileSync(credsFile, `Whaser demo accounts (rotated; the old public "password" no longer works):\n${issued.map(([u, p]) => `${u}: ${p}`).join('\n')}\n`);
    } catch {
      /* ignore */
    }
    console.log('[directory] seeded/rotated demo passwords ->', issued.map(([u, p]) => `${u}:${p}`).join('  '));
  }
})();

export async function authenticate(username: string, password: string): Promise<DirectoryUser | null> {
  const uname = String(username ?? '').trim().toLowerCase();
  const u = users.find((x) => x.username === uname);
  if (!u) return null;
  try {
    const a = Buffer.from(await hashPw(password, u.salt), 'hex');
    const b = Buffer.from(u.hash, 'hex');
    if (a.length === b.length && timingSafeEqual(a, b)) return u;
  } catch {
    /* ignore */
  }
  return null;
}

/** Register a new user (their own tenant). Throws on invalid/taken username or weak password. */
export async function registerUser(username: string, password: string, displayName: string): Promise<DirectoryUser> {
  const uname = String(username ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,32}$/.test(uname)) throw new Error('username must be 3-32 chars (letters, digits, . _ -)');
  if (String(password ?? '').length < 6) throw new Error('password must be at least 6 characters');
  if (users.some((u) => u.username === uname)) throw new Error('username already taken');
  const dn = String(displayName ?? '').trim() || uname;
  const salt = randomBytes(16).toString('hex');
  const user: DirectoryUser = {
    username: uname,
    displayName: dn,
    tenantId: 't_' + randomBytes(6).toString('hex'),
    tenantName: `${dn}'s workspace`,
    role: 'admin',
    salt,
    hash: await hashPw(password, salt),
  };
  users.push(user);
  saveUsers();
  return user;
}

export function tenantName(id: string): string {
  return users.find((x) => x.tenantId === id)?.tenantName ?? id;
}
