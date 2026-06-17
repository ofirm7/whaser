import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify Meta's `X-Hub-Signature-256` header against the RAW request body.
 * The signature is `sha256=` + HMAC-SHA256(rawBody, appSecret). Constant-time compare.
 */
export function verifySignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
