import {useEffect, useState} from 'react';
import type {DataClient, InstanceInfo, MemberRole} from '@book.dev/sdk';
import {useData} from '@/data';

/**
 * Whether the current caller may WRITE this instance — the signal that decides
 * if a page renders editable or whole-document read-only (OB-205; contract roles
 * admin=full, viewer=locked).
 *
 * ## Sourcing (coarse, UI-only, documented)
 * The brief's preferred shape is a per-page `authorize()` over the page's
 * visibility + `listPageAcl` + `getInstanceInfo().youRole` + the principal. On
 * this branch that can't be assembled UI-side and stay isolated from the server:
 *
 *  - `getInstanceInfo().youRole` does **not exist** yet (the brief assumed it);
 *    adding it is a server change, out of scope for this UI-isolated slice.
 *  - the roster role (`listMembers`) and per-page ACL (`listPageAcl`) are **not on
 *    the `DataClient` interface** `useData()` returns (only `getInstanceInfo` is),
 *    and `GET /api/members` is admin-gated anyway (a viewer 403s).
 *  - `StoredPage` carries no `visibility`, and the post-`inherit` effective
 *    visibility isn't resolvable client-side.
 *
 * So this falls back to the coarse signal the brief sanctions ("v1 hide-not-break,
 * the server is the real enforcement — writes 403 regardless"), read from the one
 * sharing method on the interface, {@link DataClient.getInstanceInfo}:
 *
 *  - the loopback owner (`verifiedVia==='local'`) and any signed-in (`jws`) user
 *    are treated as writers — keeping owner / admin / writer editing unchanged;
 *  - a guest (or other non-`jws`) is a writer only when the guest gate is open
 *    (`guestAccess==='write'`) — so an anonymous reader on a `read`/`off` instance
 *    renders read-only;
 *  - everything else renders read-only.
 *
 * ### Known v1 gap (errs toward writable = hide-not-break)
 * A signed-in **roster viewer** (a `jws` user with role `viewer`) is rendered
 * editable here, not locked — we can't tell them from an admin without the role.
 * Their writes are still rejected by the server (403), so it's "show chrome that
 * no-ops", never data corruption. The seam below already reads `youRole` if a
 * future server build adds it to `InstanceInfo` — at which point jws viewers lock
 * correctly with **no UI change**. ACL-write grantees and per-page visibility are
 * likewise out of this coarse v1 (they'd need the per-page `authorize()` inputs).
 *
 * Defaults to writable while loading / on error, so the common owner case never
 * flashes locked and a transient failure never strands a writer.
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
    pending = client
      .getInstanceInfo()
      .then(canWriteFromInstance)
      .catch(() => true); // unavailable (older server / offline) → fail open (writable)
    cache.set(client, pending);
  }
  return pending;
}

/** The coarse decision (see {@link useCanWrite}). Pure, so it's unit-testable. */
export function canWriteFromInstance(info: InstanceInfo): boolean {
  // Forward-compatible seam: the moment the server stamps the active-persona role
  // onto `InstanceInfo`, this becomes the exact viewer/admin decision — no UI
  // change. Until then `youRole` is `undefined` and we fall through to coarse.
  const youRole = (info as InstanceInfo & {youRole?: MemberRole | null}).youRole;
  if (youRole === 'admin') return true;
  if (youRole === 'viewer') return false;

  const {you, guestAccess, ownerSubject} = info;
  // Loopback owner + the claimed owner always write.
  if (you.verifiedVia === 'local') return true;
  if (ownerSubject != null && you.subject === ownerSubject) return true;
  // Any signed-in user is treated as a writer (owner / admin / ACL) — viewers
  // lean on the server's 403 until `youRole` lands (documented v1 gap).
  if (you.verifiedVia === 'jws') return true;
  // A guest / anonymous reader writes only when the guest gate is open.
  return guestAccess === 'write';
}
