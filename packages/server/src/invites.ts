/**
 * Invite resolution — email-or-handle, multi-email aware (OB-191; contract
 * `docs/sharing-access-contract-spike-OB-182.md` §4.3 / §4.4).
 *
 * An inviter names a person one of three ways; this normalizes that single free
 * string into the storage shape the roster / per-page ACL CRUD already speaks
 * (an EMAIL persona, or a SUBJECT-keyed grant):
 *
 *  - **Email** (`alice@x.test`) → an `email` persona (§4.3 by-email). Not yet a
 *    subject; the existing claim-on-sign-in (`claimMemberships`, OB-189/190)
 *    binds it to the invitee's verified subject on their first JWS request.
 *  - **Subject** (`iss#sub`) → a `subject`-keyed grant straight away (§4.3
 *    by-handle = "already a member"): the shape a resolved handle or a roster
 *    pick yields, so the share UI resolves its selection to a subject and posts
 *    that.
 *  - **Bare handle** (`@alice` / `alice`) → resolved via the {@link HandleResolver}
 *    seam (the OB-195 `/api/identity/resolve` account-handle service). Account
 *    handles are NOT built yet (§4.4 — a curated, enumeration-resistant set), so
 *    when no resolver is wired this is a clear, typed stub rather than a silent
 *    failure: the caller is told to invite by email or subject instead.
 */

/** A resolved invitee target — exactly one of `email` / `subject` is set. */
export interface ResolvedInvitee {
  /** A persona email (lowercased) — bound to a subject on first sign-in. */
  email?: string;
  /** A bound `iss#sub` — granted immediately (a resolved handle / roster pick). */
  subject?: string;
}

/**
 * The OB-195 account handle-resolution seam (`/api/identity/resolve`). A
 * whitelisted account handle resolves to a stable subject; everything else
 * resolves to `null` (enumeration-resistant, §4.4 — there is no directory). Not
 * wired until OB-195 lands, so {@link resolveInvitee} treats a bare handle as a
 * documented stub when this is absent.
 */
export interface HandleResolver {
  /** Resolve a whitelisted account handle to its subject, or `null` if unknown. */
  resolve(handle: string): Promise<{subject: string} | null>;
}

/** A resolvable-input failure, carrying the HTTP status the route should answer. */
export class InviteResolutionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 422 = 422,
  ) {
    super(message);
    this.name = 'InviteResolutionError';
  }
}

// Deliberately permissive — the authority is the issuer's verified `email` claim,
// not this shape check; we only reject the obviously-not-an-address.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Normalize a single invitee string (email | subject | handle) into a
 * {@link ResolvedInvitee}. Throws {@link InviteResolutionError} for an empty
 * input, a malformed email, or an unresolvable bare handle.
 */
export async function resolveInvitee(raw: string, resolver?: HandleResolver): Promise<ResolvedInvitee> {
  const value = raw.trim();
  if (!value) throw new InviteResolutionError('an invitee (email or handle) is required', 400);
  // A leading `@` is the handle sigil (`@alice`); an email never starts with it.
  const handle = value.startsWith('@') ? value.slice(1) : value;

  // Email persona (§4.3 by-email).
  if (EMAIL_RE.test(handle)) return {email: handle.toLowerCase()};
  // An `@` that didn't match the email shape is a malformed address, not a handle.
  if (handle.includes('@')) throw new InviteResolutionError(`"${value}" is not a valid email`, 400);

  // A pasted subject (`iss#sub`) — an already-bound identity (§4.3 by-handle).
  if (handle.includes('#')) return {subject: handle};

  // A bare handle. Account-level whitelisted handles aren't built yet (§4.4);
  // resolve via the OB-195 seam when present, else this is a clear stub.
  if (resolver) {
    const hit = await resolver.resolve(handle);
    if (hit) return {subject: hit.subject};
  }
  throw new InviteResolutionError(
    `cannot resolve handle "${value}": account-handle lookup is not available yet (OB-195). ` +
      'Invite by email, or by subject (iss#sub).',
    422,
  );
}
