import { describe, it, expect } from 'vitest';
import { hashSender } from '../src/senderHash';

describe('hashSender', () => {
  it('is deterministic for the same number + salt', () => {
    expect(hashSender('15551230000', 'salt')).toBe(hashSender('15551230000', 'salt'));
  });
  it('differs by salt', () => {
    expect(hashSender('15551230000', 'a')).not.toBe(hashSender('15551230000', 'b'));
  });
  it('does not contain the raw number', () => {
    expect(hashSender('15551230000', 'salt')).not.toContain('15551230000');
  });
});
