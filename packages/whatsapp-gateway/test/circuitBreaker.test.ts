import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../src/circuitBreaker';

function fakeClock(start = 1_000_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const base = { perSenderPerMinute: 3, maxInboundChars: 100, tenantDailyTokenBudget: 1000 };

describe('CircuitBreaker', () => {
  it('blocks oversized messages', () => {
    const b = new CircuitBreaker({ ...base, now: fakeClock().now });
    const d = b.allow({ senderHash: 's', tenantId: 't', textLength: 101 });
    expect(d).toEqual({ allowed: false, reason: 'message_too_large' });
  });

  it('enforces per-sender rate limit within the 60s window, then resets', () => {
    const clk = fakeClock();
    const b = new CircuitBreaker({ ...base, now: clk.now });
    for (let i = 0; i < 3; i++) {
      expect(b.allow({ senderHash: 's', tenantId: 't', textLength: 1 }).allowed).toBe(true);
    }
    expect(b.allow({ senderHash: 's', tenantId: 't', textLength: 1 })).toEqual({ allowed: false, reason: 'rate_limited' });
    // a different sender is unaffected
    expect(b.allow({ senderHash: 's2', tenantId: 't', textLength: 1 }).allowed).toBe(true);
    // after the window elapses, the slot frees up
    clk.advance(61_000);
    expect(b.allow({ senderHash: 's', tenantId: 't', textLength: 1 }).allowed).toBe(true);
  });

  it('enforces the per-tenant daily token budget and resets the next day', () => {
    const clk = fakeClock();
    const b = new CircuitBreaker({ ...base, now: clk.now });
    expect(b.allow({ senderHash: 's', tenantId: 't', textLength: 1 }).allowed).toBe(true);
    b.record('t', 1000); // hits the cap
    expect(b.allow({ senderHash: 's', tenantId: 't', textLength: 1 })).toEqual({ allowed: false, reason: 'tenant_budget_exceeded' });
    expect(b.usage('t')).toBe(1000);
    clk.advance(86_400_000); // next day
    expect(b.usage('t')).toBe(0);
    expect(b.allow({ senderHash: 's', tenantId: 't', textLength: 1 }).allowed).toBe(true);
  });

  it('a budget-blocked message does not consume a rate slot', () => {
    const clk = fakeClock();
    const b = new CircuitBreaker({ ...base, now: clk.now });
    b.record('t', 1000);
    for (let i = 0; i < 5; i++) {
      expect(b.allow({ senderHash: 's', tenantId: 't', textLength: 1 }).reason).toBe('tenant_budget_exceeded');
    }
    clk.advance(86_400_000); // budget resets; rate window also long past
    expect(b.allow({ senderHash: 's', tenantId: 't', textLength: 1 }).allowed).toBe(true);
  });

  it('kill switch blocks everything', () => {
    const b = new CircuitBreaker({ ...base, now: fakeClock().now });
    b.kill();
    expect(b.allow({ senderHash: 's', tenantId: 't', textLength: 1 })).toEqual({ allowed: false, reason: 'kill_switch' });
    b.resume();
    expect(b.allow({ senderHash: 's', tenantId: 't', textLength: 1 }).allowed).toBe(true);
  });

  it('treats budget 0 as unlimited', () => {
    const b = new CircuitBreaker({ ...base, tenantDailyTokenBudget: 0, now: fakeClock().now });
    b.record('t', 10_000_000);
    expect(b.allow({ senderHash: 's', tenantId: 't', textLength: 1 }).allowed).toBe(true);
  });
});
