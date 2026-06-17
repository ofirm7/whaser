import { describe, it, expect } from 'vitest';
import { InMemoryJobStore } from '../src/inboundQueue';
import type { InboundMessage } from '../src/types';

const msg = (id: string): InboundMessage => ({
  waMessageId: id,
  from: '15551230000',
  phoneNumberId: 'PN1',
  type: 'text',
  text: 'hi',
  timestamp: 1,
});

describe('InMemoryJobStore', () => {
  it('enqueues and dedupes by waMessageId', async () => {
    const s = new InMemoryJobStore();
    expect(await s.enqueue(msg('a'))).toBe(true);
    expect(await s.enqueue(msg('a'))).toBe(false);
    expect(await s.size()).toBe(1);
  });

  it('leases FIFO and marks processing', async () => {
    const s = new InMemoryJobStore();
    await s.enqueue(msg('a'));
    await s.enqueue(msg('b'));
    const j1 = await s.lease();
    const j2 = await s.lease();
    expect(j1?.waMessageId).toBe('a');
    expect(j2?.waMessageId).toBe('b');
    expect(j1?.status).toBe('processing');
    expect(await s.lease()).toBeNull();
  });

  it('completes a job', async () => {
    const s = new InMemoryJobStore();
    await s.enqueue(msg('a'));
    await s.lease();
    await s.complete('a', true);
    expect((await s.get('a'))?.status).toBe('done');
    expect((await s.get('a'))?.replySent).toBe(true);
  });

  it('re-queues on fail until maxAttempts, then fails', async () => {
    const s = new InMemoryJobStore();
    await s.enqueue(msg('a'));
    await s.lease(); // attempts = 1
    await s.fail('a', 2);
    expect((await s.get('a'))?.status).toBe('queued');
    await s.lease(); // attempts = 2
    await s.fail('a', 2);
    expect((await s.get('a'))?.status).toBe('failed');
  });
});
