import type { InboundMessage, MessagingGateway } from './types';

export interface CloudApiClientOptions {
  accessToken: string;
  graphVersion?: string;
  baseUrl?: string;
  /** Injectable for tests. Defaults to global fetch (Node 18+). */
  fetchImpl?: typeof fetch;
}

/** Sends outbound messages via the Meta WhatsApp Cloud API (Graph API). */
export class CloudApiClient implements MessagingGateway {
  private readonly accessToken: string;
  private readonly graphVersion: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CloudApiClientOptions) {
    this.accessToken = opts.accessToken;
    this.graphVersion = opts.graphVersion ?? 'v21.0';
    this.baseUrl = opts.baseUrl ?? 'https://graph.facebook.com';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async sendText(phoneNumberId: string, to: string, text: string): Promise<{ messageId: string }> {
    const url = `${this.baseUrl}/${this.graphVersion}/${phoneNumberId}/messages`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: text },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Cloud API send failed: ${res.status} ${detail}`);
    }
    const data = (await res.json()) as { messages?: Array<{ id: string }> };
    return { messageId: data.messages?.[0]?.id ?? '' };
  }
}

/**
 * Parse a Meta webhook payload into normalized inbound messages.
 * Status receipts (value.statuses) and non-message events yield an empty array.
 */
export function parseInboundWebhook(body: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const root = body as { entry?: unknown };
  const entries = Array.isArray(root?.entry) ? root.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray((entry as { changes?: unknown })?.changes)
      ? (entry as { changes: unknown[] }).changes
      : [];
    for (const change of changes) {
      const value = (change as { value?: any })?.value;
      const phoneNumberId: string = value?.metadata?.phone_number_id ?? '';
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      for (const m of messages) {
        out.push({
          waMessageId: m?.id ?? '',
          from: m?.from ?? '',
          phoneNumberId,
          type: m?.type ?? 'unknown',
          text: m?.type === 'text' ? m?.text?.body : undefined,
          timestamp: Number(m?.timestamp ?? 0),
        });
      }
    }
  }
  return out;
}
