import { describe, it, expect } from 'vitest';
import { InMemoryJobStore } from '../src/inboundQueue';
import { InboundWorker, echoHandler } from '../src/worker';
import type { InboundMessage, MessagingGateway } from '../src/types';

const msg = (id: string, text = 'ping'): InboundMessage => ({
  waMessageId: id,
  from: '15551230000',
  phoneNumberId: 'PN1',
  type: 'text',
  text,
  timestamp: 1,
});

function mockGateway() {
  const sent: Array<{ phoneNumberId: string; to: string; text: string }> = [];
  const gateway: MessagingGateway = {
    async sendText(phoneNumberId, to, text) {
      sent.push({ phoneNumberId, to, text });
      return { messageId: 'mid-' + sent.length };
    },
  };
  return { gateway, sent };
}

describe('InboundWorker (echo)', () => {
  it('echoes a text message back to the sender', async () => {
    const store = new InMemoryJobStore();
    const { gateway, sent } = mockGateway();
    await store.enqueue(msg('a', 'hello there'));
    const worker = new InboundWorker({ store, gateway, handler: echoHandler });
    expect(await worker.processOnce()).toBe(true);
    expect(sent).toEqual([{ phoneNumberId: 'PN1', to: '15551230000', text: 'hello there' }]);
    expect((await store.get('a'))?.status).toBe('done');
    expect((await store.get('a'))?.replySent).toBe(true);
  });

  it('does not double-send for a duplicate delivery', async () => {
    const store = new InMemoryJobStore();
    const { gateway, sent } = mockGateway();
    await store.enqueue(msg('a'));
    expect(await store.enqueue(msg('a'))).toBe(false); // dedupe
    const worker = new InboundWorker({ store, gateway, handler: echoHandler });
    await worker.processOnce();
    expect(await worker.processOnce()).toBe(false); // nothing left
    expect(sent.length).toBe(1);
  });

  it('retries then fails on gateway error', async () => {
    const store = new InMemoryJobStore();
    const failing: MessagingGateway = {
      async sendText() {
        throw new Error('boom');
      },
    };
    await store.enqueue(msg('a'));
    const worker = new InboundWorker({ store, gateway: failing, handler: echoHandler, maxAttempts: 2, onError: () => {} });
    await worker.processOnce(); // attempt 1 -> requeue
    expect((await store.get('a'))?.status).toBe('queued');
    await worker.processOnce(); // attempt 2 -> failed
    expect((await store.get('a'))?.status).toBe('failed');
  });

  it('ignores non-text messages (completes without a reply)', async () => {
    const store = new InMemoryJobStore();
    const { gateway, sent } = mockGateway();
    await store.enqueue({ ...msg('img'), type: 'image', text: undefined });
    const worker = new InboundWorker({ store, gateway, handler: echoHandler });
    await worker.processOnce();
    expect(sent.length).toBe(0);
    expect((await store.get('img'))?.status).toBe('done');
    expect((await store.get('img'))?.replySent).toBe(false);
  });
});
