/** Payload accepted by the anonymous form-submission endpoint. */
export interface FormSubmissionRequest {
  /** Per-form capability carried by the form block's persisted props. */
  key: string;
  /** Property-id keyed values to persist on the new database row. */
  values: Record<string, unknown>;
  /** Client-generated replay key; retries return the original result. */
  idempotencyKey: string;
}

/** Stable success response returned for both a first submission and its replay. */
export interface FormSubmissionResult {
  rowId: string;
  submittedAt: string;
}

/**
 * Mint a 256-bit, unpadded base64url form-submission capability.
 *
 * `crypto.getRandomValues` keeps this helper isomorphic across browsers and
 * current Node runtimes. The 32-byte key deliberately exceeds the contract's
 * 128-bit minimum.
 */
export function generateSubmissionKey(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
