import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MessagingGateway } from './types';

/**
 * Twilio's WhatsApp channel — the second transport behind the MessagingGateway seam (Meta's Cloud API
 * being the first). Twilio posts inbound messages to a webhook as application/x-www-form-urlencoded,
 * signed with X-Twilio-Signature; replies go out through the Programmable Messaging REST API with
 * `whatsapp:`-prefixed addresses.
 */

/** Twilio refuses a message body over 1600 characters (error 21617), so longer replies are split. */
export const TWILIO_MAX_BODY = 1600;
/** The shared Twilio Sandbox for WhatsApp sender (testers join it with "join <code>"). */
export const TWILIO_SANDBOX_NUMBER = '+14155238886';

/** A parsed form body: express.urlencoded gives a string, or an array for a repeated key. */
export type TwilioParams = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] ?? '' : v ?? '');

/** base64(HMAC-SHA1(authToken, url + name+value of every param, sorted by name)) — Twilio's scheme.
 *  A repeated param contributes each distinct value, sorted. Query-string params belong in `url`. */
export function twilioSignature(authToken: string, url: string, params: TwilioParams): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => {
      const v = params[k];
      if (v === undefined) return acc;
      return acc + (Array.isArray(v) ? [...new Set(v)].sort().map((x) => k + x).join('') : k + v);
    }, url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

/**
 * Verify X-Twilio-Signature. The signature covers the exact URL Twilio was configured with, which a
 * server behind a proxy can only reconstruct, so the caller may pass several candidate URLs; each is
 * also tried without an explicit port (Twilio's own SDKs do the same). Constant-time compare.
 */
export function verifyTwilioSignature(authToken: string, signature: string | undefined, urls: string | string[], params: TwilioParams): boolean {
  if (!signature || !authToken) return false;
  const candidates = new Set<string>();
  for (const url of Array.isArray(urls) ? urls : [urls]) {
    candidates.add(url);
    try {
      const u = new URL(url);
      candidates.add(u.toString()); // drops a default port (":443" on https)
      if (u.port) {
        u.port = '';
        candidates.add(u.toString());
      }
    } catch {
      /* not a parseable URL — the raw string is still tried */
    }
  }
  const got = Buffer.from(signature);
  for (const url of candidates) {
    const want = Buffer.from(twilioSignature(authToken, url, params));
    if (want.length === got.length && timingSafeEqual(want, got)) return true;
  }
  return false;
}

/** E.164 (+ and 8–15 digits) from what a person types or Twilio sends: "whatsapp:+1 (415) 523-8886",
 *  "0044…", "14155238886". Null when it can't be a phone number. */
export function normalizeE164(input: string): string | null {
  let s = String(input ?? '').trim().replace(/^whatsapp:/i, '').replace(/[\s().-]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) s = '+' + s;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}

/** The `whatsapp:+E164` address form Twilio's API uses for the WhatsApp channel. */
export function whatsappAddress(number: string): string {
  return /^whatsapp:/i.test(number) ? number : `whatsapp:${number}`;
}

/** One inbound WhatsApp message from Twilio's "a message comes in" webhook. */
export interface TwilioInbound {
  messageSid: string;
  accountSid: string;
  /** The customer, E.164 (the `whatsapp:` prefix removed). */
  from: string;
  /** The business number it was sent to, E.164. */
  to: string;
  body: string;
  /** The customer's WhatsApp profile name, when Twilio sends it. */
  profileName: string | null;
  media: Array<{ url: string; contentType: string }>;
}

/** Parse an inbound-message webhook. Null for anything that isn't a WhatsApp message (an SMS to the same
 *  number, a status callback, a malformed post). A tapped quick-reply button or a shared location is
 *  turned into text so the agent sees what was sent. */
export function parseTwilioInbound(params: TwilioParams): TwilioInbound | null {
  const rawFrom = first(params.From);
  const rawTo = first(params.To);
  if (!/^whatsapp:/i.test(rawFrom) || !/^whatsapp:/i.test(rawTo)) return null;
  const messageSid = first(params.MessageSid) || first(params.SmsMessageSid);
  const from = normalizeE164(rawFrom);
  const to = normalizeE164(rawTo);
  if (!messageSid || !from || !to) return null;
  const media: TwilioInbound['media'] = [];
  const n = Math.max(0, Math.min(10, Number(first(params.NumMedia)) || 0));
  for (let i = 0; i < n; i++) {
    const url = first(params[`MediaUrl${i}`]);
    if (url) media.push({ url, contentType: first(params[`MediaContentType${i}`]).split(';')[0].trim().toLowerCase() });
  }
  let body = first(params.Body);
  if (!body.trim()) body = first(params.ButtonText);
  const lat = first(params.Latitude);
  const lng = first(params.Longitude);
  if (!body.trim() && lat && lng) {
    const label = [first(params.Label), first(params.Address)].filter(Boolean).join(', ');
    body = `[location: ${lat}, ${lng}${label ? ` — ${label}` : ''}]`;
  }
  return { messageSid, accountSid: first(params.AccountSid), from, to, body, profileName: first(params.ProfileName).trim() || null, media };
}

/** A delivery update for a message we sent (the StatusCallback webhook). */
export interface TwilioStatus {
  messageSid: string;
  /** queued | sent | delivered | read | failed | undelivered | … */
  status: string;
  errorCode: string | null;
  /** The business number it was sent from, E.164 (null when Twilio didn't send a usable From). */
  from: string | null;
  /** The recipient, E.164 (null when Twilio didn't send a usable To). */
  to: string | null;
}

export function parseTwilioStatus(params: TwilioParams): TwilioStatus | null {
  const messageSid = first(params.MessageSid) || first(params.SmsSid);
  const status = (first(params.MessageStatus) || first(params.SmsStatus)).toLowerCase();
  if (!messageSid || !status) return null;
  return { messageSid, status, errorCode: first(params.ErrorCode) || null, from: normalizeE164(first(params.From)), to: normalizeE164(first(params.To)) };
}

/** Split a reply into bodies Twilio accepts, breaking at a paragraph, line, sentence or word boundary
 *  in the back half of each chunk when there is one (a hard cut otherwise, never inside a UTF-16 pair). */
export function splitMessage(text: string, max = TWILIO_MAX_BODY): string[] {
  const out: string[] = [];
  let rest = String(text ?? '').trim();
  const tiers = [['\n\n'], ['\n'], ['. ', '! ', '? ', '。'], [' ']];
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    for (const tier of tiers) {
      const at = Math.max(...tier.map((sep) => {
        const i = window.lastIndexOf(sep);
        return i < 0 ? -1 : i + sep.length;
      }));
      if (at >= max / 2) {
        cut = at;
        break;
      }
    }
    if (cut < 0) cut = /[\uD800-\uDBFF]/.test(window[max - 1]) ? max - 1 : max;
    const part = rest.slice(0, cut).trim();
    if (part) out.push(part);
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** A failed Twilio API call, with Twilio's numeric error code when it sent one (e.g. 20003 = bad credentials). */
export class TwilioApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: number | null) {
    super(message);
  }
}

export interface TwilioClientOptions {
  accountSid: string;
  authToken: string;
  /** Where Twilio posts delivery updates for messages this client sends (optional). */
  statusCallback?: string;
  baseUrl?: string;
  /** Injectable for tests. Defaults to global fetch (Node 18+). */
  fetchImpl?: typeof fetch;
}

/** Sends WhatsApp messages through Twilio's Programmable Messaging API (Basic auth: Account SID + Auth Token). */
export class TwilioWhatsAppClient implements MessagingGateway {
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly statusCallback?: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: TwilioClientOptions) {
    this.accountSid = opts.accountSid;
    this.authToken = opts.authToken;
    this.statusCallback = opts.statusCallback;
    this.baseUrl = opts.baseUrl ?? 'https://api.twilio.com';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private get authorization(): string {
    return 'Basic ' + Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
  }

  private async call<T>(path: string, init: { method?: string; body?: URLSearchParams } = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: { authorization: this.authorization, ...(init.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: init.body?.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const code = typeof data.code === 'number' ? data.code : null;
      throw new TwilioApiError(`Twilio API error ${res.status}${code ? ` (${code})` : ''}: ${String(data.message ?? res.statusText)}`, res.status, code);
    }
    return data as T;
  }

  /** Send `text` from the business number to a customer (both E.164 or whatsapp: addresses). A reply
   *  longer than Twilio's limit goes out as several messages, in order. `messageId` is the last one's SID. */
  async sendText(from: string, to: string, text: string): Promise<{ messageId: string; messageIds: string[] }> {
    const messageIds: string[] = [];
    for (const part of splitMessage(text)) {
      const body = new URLSearchParams({ From: whatsappAddress(from), To: whatsappAddress(to), Body: part });
      if (this.statusCallback) body.set('StatusCallback', this.statusCallback);
      const d = await this.call<{ sid?: string }>(`/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`, { method: 'POST', body });
      messageIds.push(String(d.sid ?? ''));
    }
    return { messageId: messageIds[messageIds.length - 1] ?? '', messageIds };
  }

  /** The account these credentials belong to — a cheap way to check a SID + token pair. */
  async fetchAccount(): Promise<{ friendlyName: string; status: string; type: string }> {
    const d = await this.call<{ friendly_name?: string; status?: string; type?: string }>(`/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}.json`);
    return { friendlyName: String(d.friendly_name ?? ''), status: String(d.status ?? ''), type: String(d.type ?? '') };
  }

  /** Download an inbound attachment (MediaUrlN). Credentials are only ever sent to Twilio's own hosts;
   *  null when it's larger than `maxBytes` or can't be fetched. */
  async downloadMedia(url: string, maxBytes = 5_000_000): Promise<Buffer | null> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    const twilioHost = u.protocol === 'https:' && (u.hostname === 'twilio.com' || u.hostname.endsWith('.twilio.com'));
    try {
      const res = await this.fetchImpl(u.toString(), { headers: twilioHost ? { authorization: this.authorization } : {}, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      if (Number(res.headers.get('content-length') ?? 0) > maxBytes) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length <= maxBytes ? buf : null;
    } catch {
      return null;
    }
  }
}
