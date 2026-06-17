import type { InboundHandler, InboundMessage, JobStore, MessagingGateway } from './types';

export interface WorkerOptions {
  store: JobStore;
  gateway: MessagingGateway;
  handler: InboundHandler;
  /** Retries before a job is marked failed. Default 3. */
  maxAttempts?: number;
  onError?: (err: unknown, msg?: InboundMessage) => void;
}

/** Phase-2 echo handler: reply with the same text. Ignores non-text messages. */
export const echoHandler: InboundHandler = async (msg) => {
  if (msg.type !== 'text' || !msg.text) return null;
  return { to: msg.from, text: msg.text };
};

/**
 * Leases inbound jobs and drives the handler → gateway reply. Idempotent: a job whose reply
 * was already sent is completed without re-sending (guards Meta's at-least-once retries and
 * crash-after-send).
 */
export class InboundWorker {
  private readonly store: JobStore;
  private readonly gateway: MessagingGateway;
  private readonly handler: InboundHandler;
  private readonly maxAttempts: number;
  private readonly onError?: WorkerOptions['onError'];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: WorkerOptions) {
    this.store = opts.store;
    this.gateway = opts.gateway;
    this.handler = opts.handler;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.onError = opts.onError;
  }

  /** Process at most one job. Returns true if a job was leased and handled. */
  async processOnce(): Promise<boolean> {
    const job = await this.store.lease();
    if (!job) return false;
    const { message } = job;
    try {
      if (job.replySent) {
        await this.store.complete(message.waMessageId, true);
        return true;
      }
      const reply = await this.handler(message);
      if (reply) {
        await this.gateway.sendText(message.phoneNumberId, reply.to, reply.text);
      }
      await this.store.complete(message.waMessageId, reply != null);
      return true;
    } catch (err) {
      this.onError?.(err, message);
      await this.store.fail(message.waMessageId, this.maxAttempts);
      return true;
    }
  }

  start(intervalMs = 250): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.processOnce();
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
