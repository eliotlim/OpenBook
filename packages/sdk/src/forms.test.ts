import {describe, expect, it} from 'vitest';
import {generateSubmissionKey} from './forms';
import {FORM_SUBMISSION_PROPERTY_ID, type DatabaseFormSubmissionMarker} from './pageProperties';

describe('generateSubmissionKey', () => {
  it('uses the reserved SDK page-property id for submission provenance', () => {
    expect(FORM_SUBMISSION_PROPERTY_ID).toBe('sys_form_submission');
    const marker: DatabaseFormSubmissionMarker = {
      submittedViaViewId: 'view_form',
      submittedAt: '2026-08-13T00:00:00.000Z',
    };
    expect(marker).toEqual({
      submittedViaViewId: 'view_form',
      submittedAt: '2026-08-13T00:00:00.000Z',
    });
  });

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
