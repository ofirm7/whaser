import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';

export type LinkStatus = 'disconnected' | 'connecting' | 'qr' | 'connected';

// Baileys wants a pino-like logger; a silent no-op keeps the console clean.
const silentLogger: any = {
  level: 'silent',
  child: () => silentLogger,
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
};

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
}

export class BaileysChannel {
  private sock: any = null;
  private starting = false;
  private status: LinkStatus = 'disconnected';
  private qrDataUrl: string | null = null;
  private me: string | null = null;
  private readonly chats = new Map<string, ChatEntry>();
  private readonly authDir = fileURLToPath(new URL('../.wa-auth', import.meta.url));

  /** onInbound receives (chatJid, senderId, text) and returns the reply text (or null to ignore). */
  constructor(private readonly onInbound: (jid: string, from: string, text: string) => Promise<string | null>) {}

  getStatus(): { status: LinkStatus; qrDataUrl: string | null; me: string | null } {
    return { status: this.status, qrDataUrl: this.qrDataUrl, me: this.me };
  }

  private numberOf(jid: string): string {
    return jid.split('@')[0].split(':')[0];
  }

  private recordChat(id: string | undefined | null, name?: string | null): void {
    if (!id || id === 'status@broadcast' || !(id.endsWith('@s.whatsapp.net') || id.endsWith('@g.us'))) return;
    const isGroup = id.endsWith('@g.us');
    const existing = this.chats.get(id);
    const resolved = (name && name.trim()) || existing?.name || this.numberOf(id);
    this.chats.set(id, { id, name: resolved, isGroup });
  }

  /** Search known chats/contacts (individuals + groups) by name or number. */
  listChats(query = '', limit = 40): ChatEntry[] {
    const q = query.trim().toLowerCase();
    const all = [...this.chats.values()].filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
    all.sort((a, b) => {
      // groups first, then by name
      if (a.isGroup !== b.isGroup) return a.isGroup ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return all.slice(0, limit);
  }

  async start(): Promise<void> {
    if (this.sock || this.starting) return;
    this.starting = true;
    this.status = 'connecting';
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const sock = makeWASocket({ auth: state, logger: silentLogger, browser: ['Whaser', 'Chrome', '1.0'] });
    this.sock = sock;
    this.starting = false;

    sock.ev.on('creds.update', saveCreds);

    // Capture chats + contacts for the chat picker.
    sock.ev.on('messaging-history.set', (h: any) => {
      for (const c of h?.contacts ?? []) this.recordChat(c.id, c.name ?? c.notify ?? c.verifiedName);
      for (const c of h?.chats ?? []) this.recordChat(c.id, c.name);
    });
    sock.ev.on('contacts.upsert', (cs: any[]) => { for (const c of cs ?? []) this.recordChat(c.id, c.name ?? c.notify ?? c.verifiedName); });
    sock.ev.on('contacts.update', (cs: any[]) => { for (const c of cs ?? []) this.recordChat(c.id, c.name ?? c.notify ?? c.verifiedName); });
    sock.ev.on('chats.upsert', (cs: any[]) => { for (const c of cs ?? []) this.recordChat(c.id, c.name); });

    sock.ev.on('connection.update', async (u: any) => {
      if (u.qr) {
        this.status = 'qr';
        try { this.qrDataUrl = await QRCode.toDataURL(u.qr); } catch { this.qrDataUrl = null; }
      }
      if (u.connection === 'open') {
        this.status = 'connected';
        this.qrDataUrl = null;
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
        if (!m.message || m.key?.fromMe) continue;
        const jid: string = m.key?.remoteJid ?? '';
        // Allow individuals + groups; skip status/broadcast. The agent's chat allow-list
        // (resolver binding) decides whether to actually reply.
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast')) continue;
        if (!(jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us'))) continue;
        const text: string = m.message.conversation ?? m.message.extendedTextMessage?.text ?? '';
        if (!text.trim()) continue;
        const from = this.numberOf(jid);
        try {
          const reply = await this.onInbound(jid, from, text);
          if (reply) await sock.sendMessage(jid, { text: reply });
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
