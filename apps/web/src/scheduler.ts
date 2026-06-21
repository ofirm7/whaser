import type { StoredAgent, AgentTrigger } from './store';
import { intervalMs, MIN_INTERVAL_MS, DAILY_FIRE_BUDGET } from './store';

/** What the scheduler needs from AppState (narrow seam to avoid a circular type). */
export interface SchedulerDeps {
  eachAgent(): StoredAgent[];
  fireTrigger(agentId: string, trigger: AgentTrigger): Promise<void>;
  /** Shared overlap guard — true while the trigger is mid-fire (scheduled OR manual "Run now"). */
  isFiring(trgId: string): boolean;
}

/** Tick cadence — finer than MIN_INTERVAL_MS so per-trigger cadence is honored without busy-spin. */
const TICK_MS = 10_000;

/**
 * Fires agents' enabled scheduled triggers automatically, independent of any inbound message.
 * Owned and started by AppState. Safety: only live agents + enabled triggers fire; each trigger
 * never overlaps itself (inflight guard); failing triggers back off exponentially; the MIN_INTERVAL
 * floor caps the fastest cadence; a per-tenant/day budget circuit-breaks runaway fan-out.
 */
export class TriggerScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly firesByTenantDay = new Map<string, number>(); // `${tenantId}:${utcDay}` -> count

  constructor(private readonly deps: SchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch {
        /* never let a bad tick kill the loop */
      }
    }, TICK_MS);
    this.timer.unref?.(); // never block process exit
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private tick(): void {
    const now = Date.now();
    const today = Math.floor(now / 864e5);
    // Drop stale day buckets so the budget map can't grow unbounded over a long-running process.
    for (const k of this.firesByTenantDay.keys()) if (!k.endsWith(`:${today}`)) this.firesByTenantDay.delete(k);

    for (const agent of this.deps.eachAgent()) {
      if (agent.status !== 'live') continue; // only live agents fire
      for (const t of agent.triggers ?? []) {
        try {
          if (!t.enabled || this.deps.isFiring(t.id)) continue; // overlap guard (scheduled or manual run in flight)
          const base = Math.max(intervalMs(t), MIN_INTERVAL_MS); // MIN floor: 'second' can't fire faster than 30s
          const backoff = base * Math.pow(2, Math.min(t.consecutiveErrors ?? 0, 5)); // exp backoff, max 32x
          const baseline = t.lastRunAt ?? t.createdAt; // first fire one interval after creation/enable (no instant fire)
          if (now < baseline + backoff) continue;
          const dayKey = `${agent.tenantId}:${today}`;
          if ((this.firesByTenantDay.get(dayKey) ?? 0) >= DAILY_FIRE_BUDGET) {
            t.lastStatus = 'skipped';
            continue;
          }
          this.firesByTenantDay.set(dayKey, (this.firesByTenantDay.get(dayKey) ?? 0) + 1);
          void this.deps.fireTrigger(agent.id, t).catch(() => {
            /* fireTrigger records its own lastError */
          });
        } catch {
          /* skip this trigger only */
        }
      }
    }
  }
}
