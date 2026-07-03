import {describe, it, expect} from 'vitest';
import type {InstanceInfo, Principal, VerifiedVia} from '@book.dev/sdk';
import {canWriteFromInstance} from '../useCanWrite';

function principal(verifiedVia: VerifiedVia, subject = 'who'): Principal {
  return {kind: verifiedVia === 'guest' ? 'guest' : 'user', subject, issuer: '', name: '', verifiedVia};
}

function info(over: Partial<InstanceInfo> & {you: Principal}): InstanceInfo {
  return {guestAccess: 'read', ownerSubject: null, trustedIssuers: [], audience: null, ...over};
}

describe('canWriteFromInstance (coarse viewer/writer signal)', () => {
  it('lets the loopback owner write', () => {
    expect(canWriteFromInstance(info({you: principal('local')}))).toBe(true);
  });

  it('lets the claimed owner write', () => {
    expect(
      canWriteFromInstance(info({ownerSubject: 'iss#o', you: principal('jws', 'iss#o')})),
    ).toBe(true);
  });

  it('treats any signed-in user as a writer (admins unchanged; viewer leans on 403)', () => {
    expect(canWriteFromInstance(info({ownerSubject: 'iss#o', you: principal('jws', 'iss#someone')}))).toBe(true);
  });

  it('locks a guest unless the guest gate is open', () => {
    expect(canWriteFromInstance(info({guestAccess: 'read', you: principal('guest')}))).toBe(false);
    expect(canWriteFromInstance(info({guestAccess: 'off', you: principal('guest')}))).toBe(false);
    expect(canWriteFromInstance(info({guestAccess: 'write', you: principal('guest')}))).toBe(true);
  });

  it('honours the server-stamped effective youRole when present (P1-8)', () => {
    // A signed-in roster VIEWER would be writable coarsely (jws), but the explicit
    // viewer role locks the editor read-only (OB-205) — no "no-op then 403" chrome.
    expect(
      canWriteFromInstance(info({ownerSubject: 'iss#o', you: principal('jws', 'iss#v'), youRole: 'viewer'})),
    ).toBe(false);
    // A guest would be locked coarsely, but an explicit admin role unlocks writing.
    expect(canWriteFromInstance(info({guestAccess: 'off', you: principal('guest'), youRole: 'admin'}))).toBe(true);
    // The owner role always writes, even where the coarse gate would otherwise deny.
    expect(canWriteFromInstance(info({guestAccess: 'off', you: principal('guest'), youRole: 'owner'}))).toBe(true);
    // The local owner resolves to `owner` server-side and keeps write.
    expect(canWriteFromInstance(info({you: principal('local'), youRole: 'owner'}))).toBe(true);
  });
});
