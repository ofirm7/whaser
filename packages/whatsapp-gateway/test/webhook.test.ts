import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyChallenge, handleInbound } from '../src/webhook';
import { parseInboundWebhook } from '../src/cloudApiClient';
import { InMemoryJobStore } from '../src/inboundQueue';

const appSecret = 'sekret';
const sign = (body: string) => 'sha256=' + createHmac('sha256', appSecret).update(body).digest('hex');

const inbound = (id: string, text = 'hello') =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: 'PN1' },
              messages: [{ from: '15551230000', id, timestamp: '1700000000', type: 'text', text: { body: text } }],
            },
          },
        ],
      },
    ],
  });

describe('verifyChallenge', () => {
  it('returns the challenge on a valid subscribe', () => {
    expect(
      verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'tok', 'hub.challenge': '12345' }, 'tok'),
    ).toBe('12345');
  });
  it('returns null on a wrong token', () => {
    expect(
      verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'bad', 'hub.challenge': '12345' }, 'tok'),
    ).toBeNull();
  });
});

describe('parseInboundWebhook', () => {
  it('extracts text + routing metadata', () => {
    const msgs = parseInboundWebhook(JSON.parse(inbound('wamid.1', 'hey')));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ waMessageId: 'wamid.1', from: '15551230000', phoneNumberId: 'PN1', type: 'text', text: 'hey' });
  });
  it('returns [] for status-only webhooks', () => {
    const body = { entry: [{ changes: [{ value: { statuses: [{ id: 'x', status: 'delivered' }] } }] }] };
    expect(parseInboundWebhook(body)).toEqual([]);
  });
});

describe('handleInbound', () => {
  it('rejects a bad signature with 401 and enqueues nothing', async () => {
    const store = new InMemoryJobStore();
    const body = inbound('wamid.1');
    const r = await handleInbound({ rawBody: body, signature: 'sha256=deadbeef', appSecret, store });
    expect(r.status).toBe(401);
    expect(await store.size()).toBe(0);
  });

  it('accepts a valid signature and enqueues', async () => {
    const store = new InMemoryJobStore();
    const body = inbound('wamid.1');
    const r = await handleInbound({ rawBody: body, signature: sign(body), appSecret, store });
    expect(r.status).toBe(200);
    expect(r.enqueued).toBe(1);
    expect(await store.size()).toBe(1);
  });

  it('dedupes duplicate deliveries of the same wa id', async () => {
    const store = new InMemoryJobStore();
    const body = inbound('wamid.dup');
    await handleInbound({ rawBody: body, signature: sign(body), appSecret, store });
    const r2 = await handleInbound({ rawBody: body, signature: sign(body), appSecret, store });
    expect(r2.enqueued).toBe(0);
    expect(await store.size()).toBe(1);
  });

  it('acks 200 with 0 enqueued for status-only webhooks', async () => {
    const store = new InMemoryJobStore();
    const body = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'x', status: 'read' }] } }] }] });
    const r = await handleInbound({ rawBody: body, signature: sign(body), appSecret, store });
    expect(r.status).toBe(200);
    expect(r.enqueued).toBe(0);
  });
});
