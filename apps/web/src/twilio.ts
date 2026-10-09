import { fileURLToPath } from 'node:url';
import { JsonStore, without } from './jsonStore';
import { TwilioWhatsAppClient, TwilioApiError, normalizeE164, TWILIO_SANDBOX_NUMBER } from '../../../packages/whatsapp-gateway/src/twilio';
import type { TwilioInbound } from '../../../packages/whatsapp-gateway/src/twilio';

/**
 * Twilio WhatsApp — official WhatsApp business numbers for agents (the Twilio Sandbox for testing, or
 * registered WhatsApp senders). No QR link, no personal phone, and nothing for a workspace to set up in
 * an outside console.
 *
 * The OPERATOR connects one Twilio account, once, in the server environment:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   — the account
 *   TWILIO_WHATSAPP_NUMBERS                 — its WhatsApp senders, comma-separated (+14155238886 = Sandbox)
 *   TWILIO_SANDBOX_JOIN_CODE                — optional: the Sandbox's "join <two-words>" code, so testers
 *                                             get a one-tap link instead of hunting for it
 *   TWILIO_WEBHOOK_BASE_URL                 — optional: the public base URL, when a proxy hides it
 * and points each number's "When a message comes in" webhook at <public URL>/api/twilio/whatsapp.
 *
 * A WORKSPACE then clicks "Get a WhatsApp number" in Settings — it's given a free number from that list
 * — and picks the agent that answers it. Everyone who messages the number talks to that agent. Inbound
 * posts are checked against X-Twilio-Signature; replies go out through the REST API, and Twilio reports
 * failed deliveries to a status callback so the workspace can see why (outside the 24-hour window, a
 * tester who hasn't joined the Sandbox, …).
 */

export const TWILIO_WEBHOOK_PATH = '/api/twilio/whatsapp';
export const TWILIO_STATUS_PATH = '/api/twilio/status';

/** The operator's Twilio account and the WhatsApp numbers workspaces can claim. */
export interface TwilioPlatform {
  accountSid: string;
  authToken: string;
  /** WhatsApp senders on the account, E.164. */
  numbers: string[];
  /** The Sandbox's "join <two-words>" message, when the operator shared it. */
  sandboxJoin: string | null;
}

const ACCOUNT_SID_RE = /^AC[0-9a-f]{32}$/i;

/** Read the operator's Twilio setup from the environment. `problem` explains a half-done setup. */
export function twilioPlatformFromEnv(env: NodeJS.ProcessEnv = process.env): { platform: TwilioPlatform | null; problem: string | null } {
  const accountSid = (env.TWILIO_ACCOUNT_SID ?? '').trim();
  const authToken = (env.TWILIO_AUTH_TOKEN ?? '').trim();
  const rawNumbers = (env.TWILIO_WHATSAPP_NUMBERS ?? env.TWILIO_WHATSAPP_NUMBER ?? '').split(',').map((n) => n.trim()).filter(Boolean);
  if (!accountSid && !authToken && !rawNumbers.length) return { platform: null, problem: null };
  if (!ACCOUNT_SID_RE.test(accountSid)) return { platform: null, problem: 'TWILIO_ACCOUNT_SID is missing or is not an Account SID (AC followed by 32 characters)' };
  if (!authToken) return { platform: null, problem: 'TWILIO_AUTH_TOKEN is missing' };
  const numbers = [...new Set(rawNumbers.map((n) => normalizeE164(n)).filter((n): n is string => !!n))];
  if (!numbers.length) return { platform: null, problem: 'TWILIO_WHATSAPP_NUMBERS has no valid number (use E.164, e.g. +14155238886)' };
  const bad = rawNumbers.filter((n) => !normalizeE164(n));
  const code = (env.TWILIO_SANDBOX_JOIN_CODE ?? '').trim().replace(/^join\s+/i, '');
  return {
    platform: { accountSid, authToken, numbers, sandboxJoin: code ? `join ${code}` : null },
    problem: bad.length ? `ignored TWILIO_WHATSAPP_NUMBERS entries that aren't phone numbers: ${bad.join(', ')}` : null,
  };
}

/** A workspace's claimed number and the agent answering it. */
interface LineRecord {
  number: string;
  agentId: string | null;
  claimedBy: string;
  claimedAt: number;
}

/** What happened on a workspace's line lately — in memory only, shown in Settings. */
interface LineActivity {
  lastInboundAt: number | null;
  lastInboundFrom: string | null;
  lastReplyAt: number | null;
  lastProblem: { message: string; code: string | null; at: number } | null;
}

/** What Settings shows a workspace about its WhatsApp business number. */
export interface TwilioSettings {
  /** The server has a Twilio account to give numbers out from. */
  available: boolean;
  /** This workspace's number ('' until it gets one). */
  number: string;
  sandbox: boolean;
  /** For the Sandbox: the message testers send first, and a wa.me link that opens WhatsApp with it typed. */
  sandboxJoin: { text: string; link: string } | null;
  /** Numbers still free for a workspace to get. */
  freeNumbers: number;
  agentId: string | null;
  claimedBy: string | null;
  claimedAt: number | null;
  activity: LineActivity;
  /** Something the operator has to fix (credentials rejected, unreadable saved file), or null. */
  problem: string | null;
}

const isObj = (r: unknown): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r);
const isLine = (r: unknown): boolean => isObj(r) && typeof r.number === 'string' && typeof r.claimedBy === 'string';

/** Why Twilio couldn't (or shouldn't) call this URL: 'local' = a loopback/private address it can't reach,
 *  'http' = reachable but unencrypted (Twilio allows it; https is recommended). Null when it's fine. */
export function webhookUrlProblem(url: string): 'local' | 'http' | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'local';
  }
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local =
    h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === '0.0.0.0' ||
    h === '::1' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) ||
    /^(127|10)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    (!h.includes('.') && !h.includes(':')); // a bare intranet hostname
  if (local) return 'local';
  return u.protocol === 'https:' ? null : 'http';
}

/** Plain-language reasons for the Twilio / WhatsApp errors that actually come up. */
const ERRORS: Record<string, string> = {
  '63016': "WhatsApp only allows free-form replies within 24 hours of the customer's last message. Outside that window a pre-approved template is needed.",
  '63015': "This person hasn't joined the Twilio Sandbox. They need to send the Sandbox join message to +1 415 523 8886 first, and again once their 3-day Sandbox session ends.",
  '63007': "The server's Twilio account has no WhatsApp sender for this number — the Whaser operator needs to check TWILIO_WHATSAPP_NUMBERS.",
  '63003': "WhatsApp couldn't reach this recipient (the number may not be on WhatsApp).",
  '63024': "WhatsApp says this recipient isn't valid (the number may not be on WhatsApp).",
  '63018': "Twilio's WhatsApp rate limit was reached; messages are being throttled.",
  '63112': 'Meta has disabled or restricted this WhatsApp Business account.',
  '21211': "The recipient's number isn't valid.",
  '21606': "This number isn't a valid WhatsApp sender for the server's Twilio account.",
  '21617': 'The message was longer than Twilio allows.',
  '20003': "Twilio rejected the server's Account SID / Auth Token — the Whaser operator needs to fix them.",
};

export function explainTwilioError(code: string | number | null | undefined): string {
  const c = code == null ? '' : String(code);
  if (!c) return 'Twilio could not deliver the message.';
  return ERRORS[c] ?? `Twilio error ${c} — see https://www.twilio.com/docs/api/errors/${encodeURIComponent(c)}`;
}

export type TurnMedia = { kind: 'image' | 'document'; base64: string; mediaType: string; filename?: string };

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/** Turn an inbound Twilio message into what the agent sees: the text, plus the first image / PDF (≤5MB)
 *  for the model to look at. Text-like files are inlined; audio/video are acknowledged (the model can't
 *  hear or watch them) — the same handling as the QR-linked channel. Null when there's nothing to answer. */
export async function inboundTurn(client: Pick<TwilioWhatsAppClient, 'downloadMedia'>, m: TwilioInbound): Promise<{ text: string; media?: TurnMedia } | null> {
  let text = m.body.trim();
  let media: TurnMedia | undefined;
  const att = m.media[0];
  if (att) {
    const ct = att.contentType;
    if (IMAGE_TYPES.includes(ct)) {
      const buf = await client.downloadMedia(att.url);
      if (buf) media = { kind: 'image', base64: buf.toString('base64'), mediaType: ct };
      else text = text || "[image — couldn't be downloaded]";
    } else if (ct === 'application/pdf') {
      const buf = await client.downloadMedia(att.url);
      if (buf) media = { kind: 'document', base64: buf.toString('base64'), mediaType: 'application/pdf', filename: 'document.pdf' };
      else text = text || "[document (PDF) — couldn't be read]";
    } else if (/^text\//.test(ct) || ct === 'application/json') {
      const buf = await client.downloadMedia(att.url);
      text = buf ? `${text || '[document]'}\n\n${buf.toString('utf8').slice(0, 12000)}` : text || `[document (${ct}) — couldn't be read]`;
    } else if (ct.startsWith('audio/')) {
      text = text || '[voice message]';
    } else if (ct.startsWith('video/')) {
      text = text || '[video]';
    } else {
      text = text || `[attachment${ct ? ` (${ct})` : ''}]`;
    }
    if (m.media.length > 1) text = `${text}\n[+${m.media.length - 1} more attachment(s) not shown]`.trim();
  }
  const effective = text.trim() || (media ? (media.kind === 'document' ? '[document]' : '[image]') : '');
  return effective ? { text: effective, media } : null;
}

/** The operator's numbers, which workspace holds each, and the agent answering it. */
export class TwilioLines {
  private readonly store: JsonStore<LineRecord>;
  private readonly activity = new Map<string, LineActivity>();
  /** The base URL a signed webhook last reached us at — the most reliable base for status callbacks. */
  private reachedAt: string | null = null;
  /** Set when Twilio rejected the operator's credentials at startup. */
  private credentialsRejected = false;

  constructor(readonly platform: TwilioPlatform | null, file = fileURLToPath(new URL('../.data/twilio-lines.json', import.meta.url))) {
    this.store = new JsonStore<LineRecord>(file, 'WhatsApp number assignments', isLine, 'twilio');
  }

  /** The workspace's line — only while its number is still one of the operator's configured numbers. */
  get(tenantId: string): LineRecord | undefined {
    const r = this.store.data[tenantId];
    return r && this.platform?.numbers.includes(r.number) ? r : undefined;
  }

  /** The workspace holding a number, or null. */
  tenantOf(number: string): string | null {
    for (const tenantId of Object.keys(this.store.data)) if (this.get(tenantId)?.number === number) return tenantId;
    return null;
  }

  /** Every workspace holding a number — for re-binding answering agents at startup. */
  all(): Array<{ tenantId: string; record: LineRecord }> {
    return Object.keys(this.store.data).flatMap((tenantId) => {
      const record = this.get(tenantId);
      return record ? [{ tenantId, record }] : [];
    });
  }

  private free(): string[] {
    return (this.platform?.numbers ?? []).filter((n) => !this.tenantOf(n));
  }

  private line(tenantId: string): LineActivity {
    let a = this.activity.get(tenantId);
    if (!a) {
      a = { lastInboundAt: null, lastInboundFrom: null, lastReplyAt: null, lastProblem: null };
      this.activity.set(tenantId, a);
    }
    return a;
  }

  settings(tenantId: string): TwilioSettings {
    const r = this.get(tenantId);
    const sandbox = r?.number === TWILIO_SANDBOX_NUMBER;
    const join = sandbox ? this.platform?.sandboxJoin : null;
    return {
      available: !!this.platform,
      number: r?.number ?? '',
      sandbox,
      sandboxJoin: join && r ? { text: join, link: `https://wa.me/${r.number.slice(1)}?text=${encodeURIComponent(join)}` } : null,
      freeNumbers: this.free().length,
      agentId: r?.agentId ?? null,
      claimedBy: r?.claimedBy ?? null,
      claimedAt: r?.claimedAt ?? null,
      activity: { ...this.line(tenantId) },
      problem: this.store.locked
        ? "Whaser couldn't read its saved WhatsApp number assignments, so changes can't be saved right now. The Whaser operator needs to check the server log."
        : this.credentialsRejected ? "Twilio rejected the server's Twilio credentials, so messages can't be sent. The Whaser operator needs to check TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN." : null,
    };
  }

  /** Give the workspace a free number (or return the one it already has). */
  claim(tenantId: string, username: string): LineRecord {
    if (!this.platform) throw new Error('WhatsApp business numbers are not available on this server yet.');
    const have = this.get(tenantId);
    if (have) return have;
    const number = this.free()[0];
    if (!number) throw new Error('All WhatsApp numbers on this server are taken. Ask the Whaser operator to add another.');
    const record: LineRecord = { number, agentId: null, claimedBy: username, claimedAt: Date.now() };
    this.store.save({ ...this.store.data, [tenantId]: record });
    return record;
  }

  /** Give the workspace's number back (it stops being answered for this workspace). */
  release(tenantId: string): void {
    if (!this.store.data[tenantId]) return;
    this.store.save(without(this.store.data, tenantId));
    this.activity.delete(tenantId);
  }

  /** Choose (or clear) the agent that answers the workspace's number. */
  setAgent(tenantId: string, agentId: string | null): void {
    const r = this.get(tenantId);
    if (!r) throw new Error('This workspace has no WhatsApp business number yet — get one in ⚙️ Settings first.');
    if (r.agentId === agentId) return;
    this.store.save({ ...this.store.data, [tenantId]: { ...r, agentId } });
  }

  /** A REST client for the operator's account, with delivery updates routed back to the status webhook
   *  (only when the public address is one Twilio can reach). Null when no account is configured. */
  client(): TwilioWhatsAppClient | null {
    if (!this.platform) return null;
    const base = process.env.TWILIO_WEBHOOK_BASE_URL?.replace(/\/+$/, '') || this.reachedAt;
    const statusCallback = base && webhookUrlProblem(base + TWILIO_STATUS_PATH) !== 'local' ? base + TWILIO_STATUS_PATH : undefined;
    return new TwilioWhatsAppClient({ accountSid: this.platform.accountSid, authToken: this.platform.authToken, statusCallback });
  }

  /** Startup check of the operator's credentials — logged, and surfaced in Settings if Twilio rejects them. */
  async verify(): Promise<void> {
    if (!this.platform) return;
    try {
      const acct = await new TwilioWhatsAppClient({ accountSid: this.platform.accountSid, authToken: this.platform.authToken }).fetchAccount();
      this.credentialsRejected = false;
      console.log(`[twilio] account "${acct.friendlyName}" (${acct.type || 'unknown type'}, ${acct.status || 'unknown status'}) — numbers: ${this.platform.numbers.join(', ')}`);
    } catch (e) {
      if (e instanceof TwilioApiError && (e.status === 401 || e.status === 403 || e.status === 404)) {
        this.credentialsRejected = true;
        console.error('[twilio] Twilio rejected TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN — WhatsApp replies will fail until they are fixed.');
      } else {
        console.warn('[twilio] could not reach Twilio to check the credentials:', e instanceof Error ? e.message : e);
      }
    }
  }

  noteInbound(tenantId: string, from: string, reachedAt: string): void {
    const a = this.line(tenantId);
    a.lastInboundAt = Date.now();
    a.lastInboundFrom = from;
    this.reachedAt = reachedAt;
  }

  noteReply(tenantId: string): void {
    this.line(tenantId).lastReplyAt = Date.now();
  }

  noteProblem(tenantId: string, message: string, code: string | null = null): void {
    this.line(tenantId).lastProblem = { message, code, at: Date.now() };
  }
}
