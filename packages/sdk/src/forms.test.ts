import {describe, expect, it} from 'vitest';
import {generateSubmissionKey} from './forms';

describe('generateSubmissionKey', () => {
  it('returns a 256-bit unpadded base64url capability', () => {
    const key = generateSubmissionKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key).not.toContain('=');
  });

  it('does not repeat across independently generated keys', () => {
    const keys = new Set(Array.from({length: 64}, () => generateSubmissionKey()));
    expect(keys.size).toBe(64);
  });
});
