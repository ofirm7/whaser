import type { JobStore } from './types';
import { verifySignature } from './signature';
import { parseInboundWebhook } from './cloudApiClient';

/**
 * GET webhook verification (one-time subscription handshake). Returns the challenge string to
 * echo back, or null if the request should be rejected (403).
 */
export function verifyChallenge(query: Record<string, unknown>, verifyToken: string): string | null {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token === verifyToken && typeof challenge === 'string') {
    return challenge;
  }
  return null;
}

export interface HandleInboundResult {
  /** 200 (ack), 401 (bad signature), or 400 (unparseable). */
  status: number;
  enqueued: number;
}

/**
 * POST webhook handler: verify the HMAC over the RAW body, parse, and enqueue (dedupe).
 * Returns fast so the caller can ACK 200 immediately; actual replies happen in the worker.
 */
export async function handleInbound(args: {
  rawBody: Buffer | string;
  signature: string | undefined;
  appSecret: string;
  store: JobStore;
}): Promise<HandleInboundResult> {
  if (!verifySignature(args.rawBody, args.signature, args.appSecret)) {
    return { status: 401, enqueued: 0 };
  }
  let body: unknown;
  try {
    body = JSON.parse(args.rawBody.toString());
  } catch {
    return { status: 400, enqueued: 0 };
  }
  let enqueued = 0;
  for (const m of parseInboundWebhook(body)) {
    if (!m.waMessageId) continue;
    if (await args.store.enqueue(m)) enqueued += 1;
  }
  return { status: 200, enqueued };
}
