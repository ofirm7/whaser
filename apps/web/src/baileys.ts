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
export class BaileysChannel {
  private sock: any = null;
  private starting = false;
  private status: LinkStatus = 'disconnected';
  private qrDataUrl: string | null = null;
  private me: string | null = null;
  private readonly authDir = fileURLToPath(new URL('../.wa-auth', import.meta.url));

  constructor(private readonly onInbound: (from: string, text: string) => Promise<string | null>) {}

  getStatus(): { status: LinkStatus; qrDataUrl: string | null; me: string | null } {
    return { status: this.status, qrDataUrl: this.qrDataUrl, me: this.me };
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

    sock.ev.on('connection.update', async (u: any) => {
      if (u.qr) {
        this.status = 'qr';
        try { this.qrDataUrl = await QRCode.toDataURL(u.qr); } catch { this.qrDataUrl = null; }
      }
      if (u.connection === 'open') {
        this.status = 'connected';
        this.qrDataUrl = null;
        this.me = sock.user?.id ? String(sock.user.id).split(':')[0].split('@')[0] : null;
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
        if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) continue; // skip groups + status
        const text: string = m.message.conversation ?? m.message.extendedTextMessage?.text ?? '';
        if (!text.trim()) continue;
        const from = jid.split('@')[0];
        try {
          const reply = await this.onInbound(from, text);
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
