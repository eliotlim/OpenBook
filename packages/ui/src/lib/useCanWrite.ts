import {useEffect, useState} from 'react';
import type {DataClient, InstanceInfo} from '@book.dev/sdk';
import {useData} from '@/data';

/**
 * Whether the current caller may WRITE this instance — the signal that decides
 * if a page renders editable or whole-document read-only (OB-205; contract roles
 * admin=full, viewer=locked).
 *
 * ## Sourcing (UI-only, {@link DataClient.getInstanceInfo})
 * Read from the server-stamped {@link InstanceInfo.youRole} (P1-8) — the caller's
 * *effective* instance role, computed server-side from the SAME `authorize()`
 * ownership ladder that enforces writes:
 *
 *  - `owner` / `admin` → writer (full editing, unchanged);
 *  - `viewer` → locked, whole-document read-only (OB-205) — no more "show chrome
 *    that no-ops then 403s"; a signed-in roster viewer now renders read-only;
 *  - `null` (a guest / signed-in stranger, or a pre-P1-8 server that omits the
 *    field) → fall through to the coarse gate below.
 *
 * The coarse fallback (for `youRole == null`) keeps the pre-P1-8 behaviour so a
 * transient/old server never newly strands a writer:
 *
 *  - the loopback owner (`verifiedVia==='local'`) and any signed-in (`jws`) user
 *    are treated as writers;
 *  - a guest (or other non-`jws`) writes only when the guest gate is open
 *    (`guestAccess==='write'`); everything else renders read-only.
 *
 * UI-only: the server's per-page `authorize()` stays the sole write enforcement,
 * so a wrong/absent `youRole` can never grant a write the server would 403, nor
 * lock out the legitimate owner (who resolves to `owner`).
 *
 * ### Known coarse residual (errs toward writable = hide-not-break)
 * Per-page ACL-write grantees and per-page visibility aren't reflected here (they
 * need the per-page `authorize()` inputs, not on the client `DataClient`); such a
 * user still leans on the server's decision. Only the clear instance-viewer case
 * locks. Defaults to writable while loading / on error, so the common owner case
 * never flashes locked.
 */
export function useCanWrite(): boolean {
  const client = useData();
  const [canWrite, setCanWrite] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void resolveCanWrite(client).then((next) => {
      if (!cancelled) setCanWrite(next);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  return canWrite;
}

/** One in-flight resolution per client, shared across every page that mounts. */
const cache = new WeakMap<DataClient, Promise<boolean>>();

function resolveCanWrite(client: DataClient): Promise<boolean> {
  let pending = cache.get(client);
  if (!pending) {
    pending = client.getInstanceInfo().then(canWriteFromInstance);
    // Don't pin a transient failure (e.g. a forwarding 502): drop it from the
    // cache so the next mount re-probes once the tunnel recovers, rather than
    // holding the fail-open default forever.
    void pending.catch(() => cache.delete(client));
    cache.set(client, pending);
  }
  // Unavailable (older server / offline / tunnel 502) → fail open (writable) so
  // an offline owner can still edit their local book. On a claimed instance the
  // server's authorize() is still the sole enforcement and 403s a real guest.
  return pending.catch(() => true);
}

/** The write decision (see {@link useCanWrite}). Pure, so it's unit-testable. */
export function canWriteFromInstance(info: InstanceInfo): boolean {
  // Server-stamped effective role (P1-8) is the exact viewer/admin/owner decision.
  // `null`/absent (guest, stranger, or a pre-P1-8 server) falls through to coarse.
  const {youRole} = info;
  if (youRole === 'owner' || youRole === 'admin') return true;
  if (youRole === 'viewer') return false;

  const {you, guestAccess, ownerSubject} = info;
  // Loopback owner + the claimed owner always write.
  if (you.verifiedVia === 'local') return true;
  if (ownerSubject != null && you.subject === ownerSubject) return true;
  // Any signed-in user is treated as a writer (owner / admin / ACL) — viewers
  // lean on the server's 403 until `youRole` lands (documented v1 gap).
  if (you.verifiedVia === 'jws') return true;
  // A guest / anonymous reader writes only on an *unclaimed* instance whose
  // guest gate is open. Once the instance is claimed (`ownerSubject` set) the
  // server's authorize() grants a guest no write regardless of `guestAccess`
  // (claiming downgrades write→read, but the value can be stale), so mirror
  // that here — never render a claimed-instance guest editor editable, or it
  // saves into a 403. See packages/sdk/src/authorize.ts (rule 0 vs rules 1-4).
  if (ownerSubject != null) return false;
  return guestAccess === 'write';
}
