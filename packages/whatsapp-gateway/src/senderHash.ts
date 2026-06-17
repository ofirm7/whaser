import { createHmac } from 'node:crypto';

/**
 * Hash an inbound sender's E.164 number before storage (PII minimization).
 * Deterministic per (number, salt) so repeat senders map to a stable key.
 */
export function hashSender(e164: string, salt: string): string {
  return createHmac('sha256', salt).update(e164).digest('hex');
}
