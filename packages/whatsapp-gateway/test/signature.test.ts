import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySignature } from '../src/signature';

const secret = 'app-secret';
const body = JSON.stringify({ hello: 'world' });
const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

describe('verifySignature', () => {
  it('accepts a valid signature', () => {
    expect(verifySignature(body, sig, secret)).toBe(true);
  });
  it('rejects a tampered body', () => {
    expect(verifySignature(body + 'x', sig, secret)).toBe(false);
  });
  it('rejects a wrong secret', () => {
    expect(verifySignature(body, sig, 'nope')).toBe(false);
  });
  it('rejects a missing or malformed header', () => {
    expect(verifySignature(body, undefined, secret)).toBe(false);
    expect(verifySignature(body, 'garbage', secret)).toBe(false);
  });
});
