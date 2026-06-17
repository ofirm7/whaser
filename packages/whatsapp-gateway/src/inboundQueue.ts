import type { InboundMessage, Job, JobStore } from './types';

/**
 * In-memory JobStore for dev/test. Production uses a MongoDB-backed store with a unique index
 * on waMessageId (dedupe) and an atomic findOneAndUpdate lease (see docs/ARCHITECTURE.md).
 */
export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly queue: string[] = [];

  async enqueue(message: InboundMessage): Promise<boolean> {
    if (this.jobs.has(message.waMessageId)) return false; // dedupe on wa_message_id
    this.jobs.set(message.waMessageId, {
      waMessageId: message.waMessageId,
      message,
      status: 'queued',
      attempts: 0,
      replySent: false,
    });
    this.queue.push(message.waMessageId);
    return true;
  }

  async lease(): Promise<Job | null> {
    while (this.queue.length) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      if (job && job.status === 'queued') {
        job.status = 'processing';
        job.attempts += 1;
        return job;
      }
    }
    return null;
  }

  async complete(waMessageId: string, replySent: boolean): Promise<void> {
    const job = this.jobs.get(waMessageId);
    if (job) {
      job.status = 'done';
      job.replySent = replySent;
    }
  }

  async fail(waMessageId: string, maxAttempts: number): Promise<void> {
    const job = this.jobs.get(waMessageId);
    if (!job) return;
    if (job.attempts >= maxAttempts) {
      job.status = 'failed';
    } else {
      job.status = 'queued';
      this.queue.push(waMessageId);
    }
  }

  async get(waMessageId: string): Promise<Job | undefined> {
    return this.jobs.get(waMessageId);
  }

  async size(): Promise<number> {
    return this.queue.length;
  }
}
