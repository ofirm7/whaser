export interface BreakerConfig {
  /** Max inbound messages per sender per rolling 60s window. */
  perSenderPerMinute: number;
  /** Max inbound message length (chars). */
  maxInboundChars: number;
  /** Hard daily token budget per tenant; 0 = unlimited (not recommended). */
  tenantDailyTokenBudget: number;
  /** Injectable clock (ms) for deterministic tests; defaults to Date.now. */
  now?: () => number;
}

export interface BreakerDecision {
  allowed: boolean;
  reason?: 'kill_switch' | 'message_too_large' | 'tenant_budget_exceeded' | 'rate_limited';
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/**
 * Deterministic, pre-model cost/abuse gate. Runs BEFORE any paid model call. Order:
 * kill-switch → size → per-tenant daily budget → per-sender rate (consumes a slot only if
 * everything else passed). `record()` accumulates spend after the model call returns.
 */
export class CircuitBreaker {
  private readonly cfg: BreakerConfig;
  private readonly now: () => number;
  private killed = false;
  private readonly senderHits = new Map<string, number[]>();
  private readonly tenantDay = new Map<string, { day: number; tokens: number }>();

  constructor(cfg: BreakerConfig) {
    this.cfg = cfg;
    this.now = cfg.now ?? Date.now;
  }

  kill(): void {
    this.killed = true;
  }

  resume(): void {
    this.killed = false;
  }

  allow(args: { senderHash: string; tenantId: string; textLength: number }): BreakerDecision {
    if (this.killed) return { allowed: false, reason: 'kill_switch' };
    if (args.textLength > this.cfg.maxInboundChars) {
      return { allowed: false, reason: 'message_too_large' };
    }
    const t = this.now();
    if (this.cfg.tenantDailyTokenBudget > 0 && this.usage(args.tenantId) >= this.cfg.tenantDailyTokenBudget) {
      return { allowed: false, reason: 'tenant_budget_exceeded' };
    }
    const recent = (this.senderHits.get(args.senderHash) ?? []).filter((ts) => ts > t - MINUTE_MS);
    if (recent.length >= this.cfg.perSenderPerMinute) {
      this.senderHits.set(args.senderHash, recent);
      return { allowed: false, reason: 'rate_limited' };
    }
    recent.push(t);
    this.senderHits.set(args.senderHash, recent);
    return { allowed: true };
  }

  /** Record token spend for a tenant against today's budget. */
  record(tenantId: string, tokens: number): void {
    const day = Math.floor(this.now() / DAY_MS);
    const rec = this.tenantDay.get(tenantId);
    if (rec && rec.day === day) rec.tokens += tokens;
    else this.tenantDay.set(tenantId, { day, tokens });
  }

  /** Tokens spent by a tenant today. */
  usage(tenantId: string): number {
    const day = Math.floor(this.now() / DAY_MS);
    const rec = this.tenantDay.get(tenantId);
    return rec && rec.day === day ? rec.tokens : 0;
  }
}
