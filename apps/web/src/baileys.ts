import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LinkStatus = 'disconnected' | 'connecting' | 'qr' | 'connected';

// Baileys wants a pino-like logger; a silent no-op keeps the console clean.
const silentLogger: any = {
  level: 'silent',
  child: () => silentLogger,
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

// Normalize a WhatsApp timestamp (UNIX seconds as number | protobuf Long | null) to ms-since-epoch.
function toMs(t: any): number {
  if (t == null) return 0;
  if (typeof t === 'number') return t * 1000;
  if (typeof t.toNumber === 'function') return t.toNumber() * 1000;
  const n = Number(t);
  return Number.isFinite(n) ? n * 1000 : 0;
}

/**
 * POC-only: links a personal WhatsApp account via the unofficial WhatsApp-Web protocol
 * (multi-device QR pairing). Inbound text messages are handed to `onInbound`, whose returned
 * string (if any) is sent back to the same chat. ToS-risky — not for production (use the
 * Cloud API path for that).
 */
export interface ChatEntry {
  id: string;
  name: string;
  isGroup: boolean;
  ts: number; // last-activity, ms since epoch (0 = unknown)
}

export class BaileysChannel {
  private sock: any = null;
  private starting = false;
  private status: LinkStatus = 'disconnected';
  private qrDataUrl: string | null = null;
  private me: string | null = null;
  private readonly chats = new Map<string, ChatEntry>();
  // Ids of messages WE sent (agent replies) — skipped when echoed back, so self-chat can't loop.
  private readonly sentIds = new Set<string>();
  // jid -> profile photo URL ('' = known no-photo, negative cache). Short-lived; cleared on reconnect.
  private readonly photoCache = new Map<string, { url: string; at: number }>();
  private static readonly PHOTO_TTL_MS = 10 * 60 * 1000; // CDN URLs live ~days, but the user may change the pic
  private readonly slug: string;
  private readonly authDir: string;
  // Persist the captured chat list so it survives restarts (the history sync only fires on a fresh pair).
  private readonly chatsFile: string;
  private saveTimer: any = null;
  // The linked owner's own recent messages — used to make agents reply in the owner's voice.
  private readonly ownerStyle: string[] = [];
  private readonly styleFile: string;
  private styleSaveTimer: any = null;

  /** Per-tenant channel: `slug` namespaces the auth/chat/style files so each user links their own
   *  WhatsApp. onInbound receives (chatJid, senderId, text) and returns the reply text (or null). */
  constructor(slug: string, private readonly onInbound: (jid: string, from: string, text: string, image?: { base64: string; mediaType: string }) => Promise<string | null>) {
    const safe = (slug || 'default').replace(/[^a-z0-9_-]/gi, '_');
    this.slug = safe;
    this.authDir = fileURLToPath(new URL('../.wa-auth/' + safe, import.meta.url));
    this.chatsFile = fileURLToPath(new URL('../.data/wa-chats-' + safe + '.json', import.meta.url));
    this.styleFile = fileURLToPath(new URL('../.data/wa-owner-style-' + safe + '.json', import.meta.url));
    try {
      if (existsSync(this.chatsFile)) {
        const arr = JSON.parse(readFileSync(this.chatsFile, 'utf8'));
        if (Array.isArray(arr)) for (const c of arr) if (c?.id) this.chats.set(c.id, { id: c.id, name: c.name ?? this.numberOf(c.id), isGroup: !!c.isGroup, ts: c.ts ?? 0 });
      }
    } catch { /* ignore */ }
    try {
      if (existsSync(this.styleFile)) {
        const arr = JSON.parse(readFileSync(this.styleFile, 'utf8'));
        if (Array.isArray(arr)) for (const s of arr) if (typeof s === 'string') this.ownerStyle.push(s);
      }
    } catch { /* ignore */ }
  }

  /** Record one of the owner's own messages as a style sample (deduped, capped). */
  private recordOwnerMessage(text: string): void {
    const t = (text ?? '').trim();
    if (t.length < 2 || t.length > 300) return; // skip trivial / very long
    if (/^https?:\/\/\S+$/i.test(t)) return; // skip bare links
    const low = t.toLowerCase();
    if (this.ownerStyle.some((s) => s.toLowerCase() === low)) return; // dedupe
    this.ownerStyle.push(t);
    if (this.ownerStyle.length > 60) this.ownerStyle.splice(0, this.ownerStyle.length - 60);
    if (this.styleSaveTimer) return;
    this.styleSaveTimer = setTimeout(() => {
      this.styleSaveTimer = null;
      try {
        const dir = dirname(this.styleFile);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(this.styleFile, JSON.stringify(this.ownerStyle));
      } catch { /* ignore */ }
    }, 1500);
  }

  /** Recent samples of how the owner writes (for style mimicry). */
  ownerStyleSamples(limit = 30): string[] {
    return this.ownerStyle.slice(-limit);
  }

  private saveChats(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        const dir = dirname(this.chatsFile);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(this.chatsFile, JSON.stringify([...this.chats.values()]));
      } catch { /* ignore */ }
    }, 1500);
  }

  getStatus(): { status: LinkStatus; qrDataUrl: string | null; me: string | null } {
    return { status: this.status, qrDataUrl: this.qrDataUrl, me: this.me };
  }

  private numberOf(jid: string): string {
    return jid.split('@')[0].split(':')[0];
  }

  private recordChat(id: string | undefined | null, name?: string | null, tsSeconds?: any): void {
    if (!id || id === 'status@broadcast' || !(id.endsWith('@s.whatsapp.net') || id.endsWith('@g.us'))) return;
    const isGroup = id.endsWith('@g.us');
    const existing = this.chats.get(id);
    const num = this.numberOf(id);
    // A "real" name is non-empty, not the WhatsApp "." placeholder, and not just the bare number.
    const real = (s?: string | null) => { const t = (s ?? '').trim(); return t && t !== '.' && t !== num ? t : ''; };
    const resolved = real(name) || real(existing?.name) || num;
    const ts = Math.max(toMs(tsSeconds), existing?.ts ?? 0); // never lower an existing recency
    this.chats.set(id, { id, name: resolved, isGroup, ts });
    this.saveChats();
  }

  /** Search known chats/contacts (individuals + groups), most-recent first; capped at `limit`.
   *  Includes the "Message Yourself" chat (own number) — agents can answer it (see messages.upsert). */
  listChats(query = '', limit = 100): ChatEntry[] {
    const q = query.trim().toLowerCase();
    // Match the name or the phone-number part only — NOT the full jid, whose "@s.whatsapp.net" /
    // "@g.us" suffix contains common letters (a, s, t, w, h, p, n, e, g, u) and matched everything.
    const all = [...this.chats.values()].filter((c) => !q || c.name.toLowerCase().includes(q) || this.numberOf(c.id).includes(q));
    const junk = (n: string) => /^[\s.,_·\-–—:;'"!?()]+$/.test(n); // name is only punctuation (e.g. "..", "...")
    // recency desc; then real names before punctuation-only/number-only; then alphabetical.
    all.sort((a, b) =>
      (b.ts - a.ts) ||
      (Number(junk(a.name)) - Number(junk(b.name))) ||
      a.name.localeCompare(b.name));
    return all.slice(0, limit);
  }

  /**
   * Lazily resolve a chat's profile photo URL (preview/low-res), or null when there's no available
   * photo (private/none/not-a-contact — those THROW in Baileys, so we catch + negative-cache).
   * Times out → not cached (retries next call).
   */
  async profilePhoto(jid: string): Promise<string | null> {
    if (!jid || !(jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us'))) return null;
    const hit = this.photoCache.get(jid);
    if (hit) {
      // Cache hits with a URL last 10 min; misses (no photo / timeout) re-check after 2 min.
      const ttl = hit.url ? BaileysChannel.PHOTO_TTL_MS : 2 * 60 * 1000;
      if (Date.now() - hit.at < ttl) return hit.url || null;
    }
    if (!this.sock || this.status !== 'connected') return hit ? hit.url || null : null;
    try {
      // 5s timeout: a non-responding picture IQ otherwise hangs ~60s (Baileys default), and the
      // picker fires ~100 of these — without a cap they saturate the socket + the browser pool.
      const url = await this.sock.profilePictureUrl(jid, 'preview', 5000);
      const ok = typeof url === 'string' && !!url;
      this.photoCache.set(jid, { url: ok ? url : '', at: Date.now() }); // cache success AND miss/timeout
      return ok ? url : null;
    } catch {
      // Thrown error IQ (404 item-not-found / 401 / 403) = no available photo → negative-cache.
      this.photoCache.set(jid, { url: '', at: Date.now() });
      return null;
    }
  }

  async start(): Promise<void> {
    if (this.sock || this.starting) return;
    this.starting = true;
    this.status = 'connecting';
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const sock = makeWASocket({
      auth: state,
      logger: silentLogger,
      browser: ['Whaser', 'Chrome', '1.0'],
      // Fetch only the recent slice (fast) — the picker shows the last 100 chats, newest first.
      // (rc13 defaults syncFullHistory:true, which dumps full history and is slow.)
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    this.sock = sock;
    this.starting = false;

    sock.ev.on('creds.update', saveCreds);

    // Capture chats + contacts for the chat picker.
    const contactName = (c: any) => c.name ?? c.verifiedName ?? c.notify ?? c.username;
    sock.ev.on('messaging-history.set', (h: any) => {
      for (const c of h?.contacts ?? []) this.recordChat(c.id, contactName(c));
      for (const c of h?.chats ?? []) this.recordChat(c.id, c.name, c.conversationTimestamp ?? c.lastMessageRecvTimestamp);
      for (const m of h?.messages ?? []) { // bootstrap the owner's style from recent self-authored history
        if (m?.key?.fromMe) { const t = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? ''; if (t) this.recordOwnerMessage(t); }
      }
    });
    sock.ev.on('contacts.upsert', (cs: any[]) => { for (const c of cs ?? []) this.recordChat(c.id, contactName(c)); });
    sock.ev.on('contacts.update', (cs: any[]) => { for (const c of cs ?? []) this.recordChat(c.id, contactName(c)); });
    sock.ev.on('chats.upsert', (cs: any[]) => { for (const c of cs ?? []) this.recordChat(c.id, c.name, c.conversationTimestamp ?? c.lastMessageRecvTimestamp); });
    sock.ev.on('chats.update', (cs: any[]) => { for (const c of cs ?? []) this.recordChat(c.id, c.name, c.conversationTimestamp ?? c.lastMessageRecvTimestamp); });

    sock.ev.on('connection.update', async (u: any) => {
      if (u.qr) {
        this.status = 'qr';
        try { this.qrDataUrl = await QRCode.toDataURL(u.qr); } catch { this.qrDataUrl = null; }
      }
      if (u.connection === 'open') {
        this.status = 'connected';
        this.qrDataUrl = null;
        this.photoCache.clear(); // drop possibly-expired signed URLs on a fresh connection
        this.me = sock.user?.id ? String(sock.user.id).split(':')[0].split('@')[0] : null;
        // Fetch group subjects so groups show readable names in the picker.
        try {
          const groups = await sock.groupFetchAllParticipating();
          for (const g of Object.values(groups ?? {}) as any[]) this.recordChat(g.id, g.subject);
        } catch { /* ignore */ }
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        this.sock = null;
        if (code === DisconnectReason.loggedOut) {
          this.status = 'disconnected';
          this.me = null;
          this.qrDataUrl = null;
        } else {
          this.status = 'connecting';
          void this.start();
        }
      }
    });

    sock.ev.on('messages.upsert', async (ev: any) => {
      if (ev.type !== 'notify') return;
      for (const m of ev.messages ?? []) {
        if (!m.message) continue;
        const id: string | undefined = m.key?.id;
        if (id && this.sentIds.has(id)) { this.sentIds.delete(id); continue; } // our own reply echoed back — ignore (loop guard)
        const imgMsg = m.message.imageMessage ?? m.message.viewOnceMessage?.message?.imageMessage ?? m.message.viewOnceMessageV2?.message?.imageMessage;
        const caption: string = imgMsg?.caption ?? '';
        const text: string = m.message.conversation ?? m.message.extendedTextMessage?.text ?? caption ?? '';
        const rawJid: string = m.key?.remoteJid ?? '';
        const altJid: string = m.key?.remoteJidAlt ?? '';
        if (!rawJid || rawJid === 'status@broadcast' || rawJid.endsWith('@broadcast') || rawJid.endsWith('@newsletter')) continue;
        // Baileys 7.x often addresses a 1:1 chat as <id>@lid (privacy); the phone-number form
        // (@s.whatsapp.net) is carried in remoteJidAlt. The chat allow-list is bound on the PN /
        // @g.us form, so match + reply on that.
        const jid = [rawJid, altJid].find((j) => j && (j.endsWith('@s.whatsapp.net') || j.endsWith('@g.us')));
        // "Message Yourself" chat: fromMe but addressed to your own number — the agent SHOULD answer it.
        const isSelf = !!m.key?.fromMe && !!jid && !!this.me && this.numberOf(jid) === this.me;
        if (m.key?.fromMe && !isSelf) { if (text) this.recordOwnerMessage(text); continue; } // owner messaging others → style only, don't reply
        if (!jid) continue; // not an individual/group we can route
        // Bump recency so an active chat floats to the top; pushName names a 1:1 contact.
        this.recordChat(jid, jid.endsWith('@g.us') ? undefined : m.pushName, m.messageTimestamp);
        // Download an attached image (current turn only) for vision; on failure/too-large, fall back to text/caption.
        let image: { base64: string; mediaType: string } | undefined;
        if (imgMsg) {
          try {
            const buf = (await downloadMediaMessage(m, 'buffer', {}, { logger: silentLogger, reuploadRequest: sock.updateMediaMessage })) as Buffer;
            if (buf && buf.length <= 5_000_000) {
              const mt = String(imgMsg.mimetype ?? '').split(';')[0];
              const mediaType = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mt) ? mt : 'image/jpeg';
              image = { base64: buf.toString('base64'), mediaType };
            } else if (buf) {
              console.error('[baileys] image too large (%d bytes) — replying to caption only', buf.length);
            }
          } catch (e) {
            console.error('[baileys] image download failed', e);
          }
        }
        const effectiveText = text.trim() || (image ? '[image]' : '');
        if (!effectiveText && !image) continue; // nothing actionable
        const from = this.numberOf(jid);
        try {
          const reply = await this.onInbound(jid, from, effectiveText, image);
          if (reply) { const sent = await sock.sendMessage(jid, { text: reply }); const sid = sent?.key?.id; if (sid) this.sentIds.add(sid); }
        } catch (e) {
          console.error('[baileys] inbound error', e);
        }
      }
    });
  }

  async logout(): Promise<void> {
    try { await this.sock?.logout?.(); } catch { /* ignore */ }
    this.sock = null;
    this.status = 'disconnected';
    this.qrDataUrl = null;
    this.me = null;
  }
}
