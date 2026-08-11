import type {FormValidationError} from './formSchema';

/** Public form-upload limits, shared by the browser runtime and server. */
export const FORM_UPLOAD_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const FORM_UPLOAD_MAX_FILES = 5;
export const FORM_UPLOAD_MAX_FORM_BYTES = 50 * 1024 * 1024;
export const FORM_UPLOAD_ORPHAN_TTL_MS = 30 * 60 * 1000;

/** File bytes and metadata accepted by the SDK's staged-upload helper. */
export interface FormUploadInput {
  key: string;
  fieldId: string;
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/** JSON/base64 wire envelope accepted by the staged-upload endpoint. */
export interface FormUploadRequest extends Omit<FormUploadInput, 'bytes'> {
  data: string;
}

/** Opaque token returned by a staged upload and submitted as a files-field value. */
export interface FormUploadResult {
  token: string;
  name: string;
  size: number;
}

/** Typed non-success response from the public staged-upload endpoint. */
export class FormUploadError extends Error {
  constructor(public readonly status: number) {
    super(`Form upload failed (${status})`);
    this.name = 'FormUploadError';
  }
}

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

/** Typed non-success response from the public form-submission endpoint. */
export class FormSubmissionError extends Error {
  constructor(
    public readonly status: number,
    public readonly errors: FormValidationError[] = [],
  ) {
    super(`Form submission failed (${status})`);
    this.name = 'FormSubmissionError';
  }
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
