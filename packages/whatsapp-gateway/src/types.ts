/** A normalized inbound WhatsApp message extracted from a Cloud API webhook. */
export interface InboundMessage {
  /** Meta's message id (wamid...). Unique — used for dedupe + idempotency. */
  waMessageId: string;
  /** Sender E.164 / wa_id. */
  from: string;
  /** Business phone number that received it; routes to an agent (Phase 3). */
  phoneNumberId: string;
  /** 'text' | 'image' | 'audio' | ... */
  type: string;
  /** Body for text messages; undefined otherwise. */
  text?: string;
  /** Media attached to THIS turn only (base64) — sent to the model, never persisted in history. */
  currentTurnMedia?: { kind: 'image' | 'document'; base64: string; mediaType: string; filename?: string };
  /** Epoch seconds. */
  timestamp: number;
}

export interface OutboundText {
  to: string;
  text: string;
}

/** Transport seam — Phase 2 has one implementation (Cloud API); kept abstract for swappability. */
export interface MessagingGateway {
  sendText(phoneNumberId: string, to: string, text: string): Promise<{ messageId: string }>;
}

/** Decides the reply for an inbound message. Returns null to send nothing. */
export type InboundHandler = (msg: InboundMessage) => Promise<OutboundText | null>;

export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface Job {
  waMessageId: string;
  message: InboundMessage;
  status: JobStatus;
  attempts: number;
  /** True once a reply has been sent — guards against double-send on retry/re-lease. */
  replySent: boolean;
}

/**
 * Durable inbound queue. The in-memory implementation is for dev/test; production uses a
 * MongoDB-backed store (atomic lease via findOneAndUpdate, unique index on waMessageId).
 */
export interface JobStore {
  /** Enqueue; returns false if a job with this waMessageId already exists (dedupe). */
  enqueue(message: InboundMessage): Promise<boolean>;
  /** Atomically lease the next queued job (status -> processing, attempts++). */
  lease(): Promise<Job | null>;
  /** Mark a leased job done; `replySent` records whether a reply was actually sent. */
  complete(waMessageId: string, replySent: boolean): Promise<void>;
  /** Re-queue a failed job, or mark it failed once attempts reach maxAttempts. */
  fail(waMessageId: string, maxAttempts: number): Promise<void>;
  get(waMessageId: string): Promise<Job | undefined>;
  /** Number of jobs currently queued (not processing/done/failed). */
  size(): Promise<number>;
}
