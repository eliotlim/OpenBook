import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Check, Link2, Loader2, Share2, Trash2} from 'lucide-react';
import {PAGE_VISIBILITIES, type AclLevel, type GuestAccess, type InstanceInfo, type PageAcl, type PageVisibility} from '@book.dev/sdk';
import {useData} from '@/data';
import {useForwarding, useHud, useOptionalAccount, usePlatformLibrary, useTranslation} from '@/providers';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {IconButton} from '@/components/ui/icon-button';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Select} from '@/components/ui/select';
import {copyPageLink} from '@/lib/pageActions';
import {cn} from '@/lib/utils';
import type {TKey} from '@/i18n';

/** i18n label per visibility scope (escalating privacy). `inherit` is presented
 *  as "Workspace default" — the honest name for the unset/inherited state. */
const SCOPE_LABEL: Record<PageVisibility, {label: TKey; hint: TKey}> = {
  inherit: {label: 'share.scope.inherit', hint: 'share.scope.inheritHint'},
  public: {label: 'share.scope.public', hint: 'share.scope.publicHint'},
  authenticated: {label: 'share.scope.authenticated', hint: 'share.scope.authenticatedHint'},
  members: {label: 'share.scope.members', hint: 'share.scope.membersHint'},
  restricted: {label: 'share.scope.restricted', hint: 'share.scope.restrictedHint'},
};

/** The copy-link hint phrased for who the *link* actually reaches at each scope —
 *  the static "anyone you invite" line contradicts `public`/`members` (F4). */
const LINK_HINT: Record<PageVisibility, TKey> = {
  inherit: 'share.linkHints.inherit',
  public: 'share.linkHints.public',
  authenticated: 'share.linkHints.authenticated',
  members: 'share.linkHints.members',
  restricted: 'share.linkHints.restricted',
};

/** Progressive-disclosure scope tiers (SHR-4). The picker used to show all five
 *  flat scopes — including dormant ones — as if equal choices. Instead surface
 *  the two that carry the everyday decision (`restricted` private vs `public`)
 *  up front, keep `inherit` ("Workspace default") primary too so "reset to the
 *  workspace default" is always reachable, tuck only the genuinely-obscure
 *  `authenticated` behind a "More access options" reveal, and hide `members`
 *  entirely (it's dormant OSS surface). Whatever a page is *currently* set to is
 *  always offered too (see `scopeOptions`), so a stored `members`/`authenticated`
 *  value still renders and stays settable. */
const PRIMARY_SCOPES: readonly PageVisibility[] = ['inherit', 'restricted', 'public'];
const ADVANCED_SCOPES: readonly PageVisibility[] = ['authenticated'];

/**
 * Map a raw client error to a friendly, localised line — the SDK throws
 * `Error("OpenBook request failed (<status> …): <server detail>")` and a bare
 * `fetch` rejects with "Failed to fetch"; neither is fit to render verbatim
 * (Devon F2 / Parker). We classify on the status / known substrings and fall
 * back to a generic line so an unmapped server message never leaks through.
 */
function shareErrorKey(e: unknown): TKey {
  const raw = e instanceof Error ? e.message : String(e);
  if (/failed to fetch|networkerror|load failed|fetch failed/i.test(raw)) return 'share.error.network';
  if (/\b40[13]\b|forbidden|unauthor/i.test(raw)) return 'share.error.forbidden';
  if (/\b404\b|not found/i.test(raw)) return 'share.error.notFound';
  return 'share.error.generic';
}

/**
 * Does this principal manage sharing instance-wide? The loopback owner, an
 * instance admin, and the claimed owner all do; on a still-unclaimed instance the
 * legacy guest gate governs (anyone who may write). This is the coarse gate for
 * the Share *entry point* — the per-page routes still enforce write server-side,
 * and the dialog degrades to an error state if a specific page load is refused.
 */
export function canManageSharing(info: InstanceInfo): boolean {
  // v1 is deliberately instance-coarse: a page-level ACL-write collaborator who
  // isn't an instance manager won't see the Share entry (hidden, not broken — the
  // per-page routes still authorize them). Per-page Share visibility is a follow-up.
  const {you, ownerSubject, guestAccess, youRole} = info;
  if (you.verifiedVia === 'local') return true;
  if (youRole === 'owner' || youRole === 'admin') return true;
  if (!ownerSubject) return guestAccess === 'write' || you.verifiedVia === 'jws';
  return you.verifiedVia === 'jws' && you.subject === ownerSubject;
}

/**
 * Whether the current user may manage page sharing (gates the Share control).
 * `null` while the one-shot `/api/instance` lookup is in flight; `false` if the
 * server predates multi-user (no endpoint) so the control simply stays hidden.
 * @deprecated Use {@link useSharingCapability} — it distinguishes "unsupported
 * server" from "not a manager" so non-managers can get the read-only view.
 */
export function useCanManageSharing(): boolean | null {
  const {supported, canManage} = useSharingCapability();
  return supported === null ? null : supported && canManage;
}

/**
 * The sharing capability of this instance and user: `supported` is `null`
 * while the one-shot `/api/instance` lookup is in flight and `false` when the
 * server predates multi-user sharing (no endpoint — the Share control stays
 * hidden entirely). When supported, everyone gets the Share entry — a
 * non-manager sees a read-only "who can access" view instead of nothing
 * (hidden was indistinguishable from broken).
 */
export function useSharingCapability(): {supported: boolean | null; canManage: boolean} {
  const client = useData();
  const [state, setState] = useState<{supported: boolean | null; canManage: boolean}>({
    supported: null,
    canManage: false,
  });
  useEffect(() => {
    let live = true;
    client
      .getInstanceInfo()
      .then((info) => live && setState({supported: true, canManage: canManageSharing(info)}))
      .catch(() => live && setState({supported: false, canManage: false}));
    return () => {
      live = false;
    };
  }, [client]);
  return state;
}

/** The display name + revoke key for one ACL grant (email persona XOR subject). */
function granteeOf(grant: PageAcl): {name: string; key: {subject: string} | {email: string}} {
  return grant.email
    ? {name: grant.email, key: {email: grant.email}}
    : {name: grant.subject ?? '', key: {subject: grant.subject ?? ''}};
}

/**
 * Inline "Publish this device" affordance (SHR-3), shown in the Share dialog when
 * a manager is on a publish-capable desktop that isn't published yet — so the
 * copied link would be dead (`tauri://localhost`). Instead of pointing at Settings,
 * it drives the SAME `useForwarding().enable()` the Settings toggle runs — claim +
 * dial out — so there's no new exposure, just no detour. Reuses the Settings
 * section's pieces (claim warning, sign-in handoff, refusal states) inline. Once
 * the tunnel is online, `publishedHost` flips and the normal copy-link footer takes
 * over.
 */
function InlinePublish() {
  const {t} = useTranslation();
  const {enable, enabled, busy, claimRefusal, signInPending, error} = useForwarding();
  const account = useOptionalAccount();
  const connected = account?.connected ?? false;
  const remintIdentity = account?.remintIdentity;
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-4">
      <p className="text-xs text-muted-foreground">{t('share.publish.hint')}</p>
      {/* Forewarn before the first publish — the same irreversible-claim warning
          as the Settings toggle. Hidden once a refusal explains the real blocker,
          and once an enable is already in progress (`enabled` but not yet
          `publishedHost`) so it doesn't redundantly re-show mid-reconnect —
          matching `SharingPublishingSettings`. */}
      {!enabled && !claimRefusal && (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
          {t('forwarding.claimWarning')}
        </p>
      )}
      <Button variant="outline" size="sm" className="self-start" disabled={busy} onClick={() => void enable()}>
        {busy ? (
          <>
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            {t('forwarding.registering')}
          </>
        ) : (
          <>
            <Share2 className="mr-1.5 h-4 w-4" />
            {t('forwarding.toggle')}
          </>
        )}
      </Button>
      {/* A signed-out publish starts the sign-in handoff and auto-resumes once the
          account connects (same as the Settings toggle) — say so, don't snap back. */}
      {!connected && (
        <p className="text-xs text-muted-foreground">
          {signInPending ? t('forwarding.signInPending') : t('forwarding.signInHint')}
        </p>
      )}
      {/* Precondition (muted, with a refresh) vs terminal vs genuine failure —
          mirrors the severity split in the Settings ForwardingSection. */}
      {claimRefusal === 'unverified' && (
        <p className="text-xs text-muted-foreground">
          {t('forwarding.claimRefusedUnverified')}
          {remintIdentity && (
            <>
              {' '}
              <button
                type="button"
                onClick={() => void remintIdentity()}
                className="font-medium underline underline-offset-2 hover:text-foreground"
              >
                {t('forwarding.refreshIdentity')}
              </button>
            </>
          )}
        </p>
      )}
      {claimRefusal === 'issuance-disabled' && (
        <p className="text-xs text-muted-foreground">{t('forwarding.claimRefusedIssuanceDisabled')}</p>
      )}
      {claimRefusal === 'claim-failed' && <p className="text-sm text-destructive">{t('forwarding.claimFailed')}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/**
 * The per-page Share dialog (OB-203) — the hub for "who can access this page".
 * A manager sets the page's audience-scope visibility and grants individual
 * people read/edit access by email or handle, all against the OB-191 per-page
 * API (`setPageVisibility`, `sharePage`/`listPageAcl`/`unsharePage`); it also
 * shows the *effective* workspace default behind `inherit` and links out to
 * the workspace-level surfaces (Sharing & publishing, Members). A non-manager
 * (`canManage: false`) gets the same dialog read-only. Rendered from the
 * page-actions cluster.
 */
export default function ShareDialog({pageId, canManage = true}: {pageId: string; canManage?: boolean}) {
  const client = useData();
  const {t} = useTranslation();
  const {setHud} = useHud();

  // Where a copied link actually reaches (P0-1). On a desktop build
  // (`supported`), the link is `tauri://localhost` — dead off this device —
  // UNLESS the workspace is published, in which case `pageLinkUrl` emits the
  // forwarded host (`publishedHost` is the same predicate that drives the
  // share-link origin registration in ForwardingProvider).
  const {supported: canPublish, publishedHost} = useForwarding();
  const linkIsLocalOnly = canPublish && !publishedHost;
  // The standalone web app's in-browser store (P0-4): the workspace lives only in
  // this browser profile, so nothing set here can reach another person and a
  // copied link opens the *recipient's own* workspace, not this page. The dialog
  // stays functional (settings persist) but must say so.
  const browserLocal = usePlatformLibrary().browserLocalWorkspace === true;

  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<PageVisibility>('inherit');
  // Progressive disclosure for the scope picker (SHR-4): collapsed by default so
  // only the primary two scopes (+ the current value) show; the "Advanced" reveal
  // adds `inherit`/`authenticated`.
  const [showAdvanced, setShowAdvanced] = useState(false);
  // The scope Select's trigger, so revealing the extra options can move focus to
  // it — making it obvious it just gained choices (SHR-4 a11y).
  const scopeSelectRef = useRef<HTMLButtonElement>(null);
  const [grants, setGrants] = useState<PageAcl[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  // Tri-state claim status, resolved from the *uncached* `getInstanceInfo()` RTT.
  // We render NEITHER the pre-claim notice nor the enforcement caveat until this
  // confirms one way or the other — otherwise the default `false` flashes the
  // wrong disclosure for a round-trip on the (common) unclaimed instance and then
  // flips (Devon F1). `'loading'` covers both in-flight and a failed lookup, so a
  // flaky probe simply shows neither rather than asserting an unverified state.
  //   • `'unclaimed'` (no `ownerSubject`): scope + ACL are saved but NOT yet
  //     enforced (authorize() rule-0 short-circuits to the legacy guest gate).
  //   • `'claimed'`: scopes are enforced on direct access; the forwarded-link
  //     caveat below applies (Parker #1).
  const [claimStatus, setClaimStatus] = useState<'loading' | 'claimed' | 'unclaimed'>('loading');
  // The workspace guest gate — what `inherit` resolves to on an *unclaimed*
  // instance (rule-0 short-circuit). `null` until the instance lookup lands.
  const [guestAccess, setGuestAccess] = useState<GuestAccess | null>(null);
  // The root default scope `inherit` resolves to once *claimed* (SHR-6). `null`
  // until the lookup lands, or on a pre-SHR-6 server that doesn't report it — in
  // which case the summary falls back to the guest-gate line below.
  const [defaultVisibility, setDefaultVisibility] = useState<Exclude<PageVisibility, 'inherit'> | null>(null);

  const [invitee, setInvitee] = useState('');
  const [level, setLevel] = useState<AclLevel>('read');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<TKey | null>(null);
  const [scopeError, setScopeError] = useState<TKey | null>(null);
  const [copied, setCopied] = useState(false);
  // Separate copied flag for the delivery-help copy button so it doesn't light
  // up the bottom copy-link button (same URL, different affordance).
  const [deliverCopied, setDeliverCopied] = useState(false);

  // Whether the roster loaded (the ACL GET is write-gated server-side, so a
  // read-only viewer gets a 403 — degrade to scope-only rather than erroring
  // the whole dialog they were just granted access to).
  const [aclReadable, setAclReadable] = useState(true);

  // The scopes offered in the picker (SHR-4): the primary two, plus the advanced
  // two once revealed, plus whatever this page is *currently* set to — so a stored
  // value (including the otherwise-hidden `members`) always renders and stays
  // selectable. Ordered by the canonical escalating-privacy order.
  const scopeOptions = useMemo<PageVisibility[]>(() => {
    const shown = new Set<PageVisibility>(PRIMARY_SCOPES);
    if (showAdvanced) ADVANCED_SCOPES.forEach((v) => shown.add(v));
    shown.add(scope);
    return PAGE_VISIBILITIES.filter((v) => shown.has(v));
  }, [showAdvanced, scope]);

  // Load the page's current scope + grants whenever the dialog opens.
  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const visibility = await client.getPageVisibility(pageId);
      setScope(visibility ?? 'inherit');
    } catch {
      setLoadError(true);
      setLoading(false);
      return;
    }
    try {
      setGrants(await client.listPageAcl(pageId));
      setAclReadable(true);
    } catch {
      // Scope loaded fine — only the roster is off-limits to this principal.
      setGrants([]);
      setAclReadable(false);
    } finally {
      setLoading(false);
    }
  }, [client, pageId]);

  useEffect(() => {
    if (!open) return;
    // Don't carry a prior scope/add failure across a close→reopen (F4).
    setScopeError(null);
    setAddError(null);
    void refresh();
  }, [open, refresh]);

  // Resolve the claim state lazily on open (kept off the page-data path so a flaky
  // instance lookup just shows neither disclosure rather than blanking the whole
  // dialog). Re-arm `'loading'` each open so a stale resolved value can't flash.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setClaimStatus('loading');
    client
      .getInstanceInfo()
      .then((info) => {
        if (!live) return;
        setClaimStatus(info.ownerSubject ? 'claimed' : 'unclaimed');
        setGuestAccess(info.guestAccess);
        setDefaultVisibility(info.defaultVisibility ?? null);
      })
      .catch(() => {
        /* leave both disclosures hidden (stay 'loading') — the dialog still works */
      });
    return () => {
      live = false;
    };
  }, [open, client]);

  const changeScope = useCallback(
    async (next: PageVisibility) => {
      const prev = scope;
      setScope(next); // optimistic
      setScopeError(null);
      try {
        await client.setPageVisibility(pageId, next);
      } catch (e) {
        setScope(prev); // revert on failure
        setScopeError(shareErrorKey(e)); // …and surface why (F2)
      }
    },
    [client, pageId, scope],
  );

  const addPerson = useCallback(async () => {
    const value = invitee.trim();
    if (!value || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      await client.sharePage(pageId, value, level);
      setInvitee('');
      await refresh();
    } catch (e) {
      setAddError(shareErrorKey(e));
    } finally {
      setAdding(false);
    }
  }, [client, pageId, invitee, level, adding, refresh]);

  const removePerson = useCallback(
    async (grant: PageAcl) => {
      try {
        await client.unsharePage(pageId, granteeOf(grant).key);
        await refresh();
      } catch {
        // The list refetch on next open will reconcile; nothing to surface here.
      }
    },
    [client, pageId, refresh],
  );

  const copyLink = useCallback(async () => {
    if (await copyPageLink(pageId)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }, [pageId]);

  const copyDeliverLink = useCallback(async () => {
    if (await copyPageLink(pageId)) {
      setDeliverCopied(true);
      window.setTimeout(() => setDeliverCopied(false), 1500);
    }
  }, [pageId]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <IconButton size="sm" aria-label={t('share.open')} title={t('share.open')}>
          <Share2 className="h-4 w-4" />
        </IconButton>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('share.title')}</DialogTitle>
          <DialogDescription>{t(canManage ? 'share.description' : 'share.readOnlyDescription')}</DialogDescription>
        </DialogHeader>

        {loadError ? (
          <p className="text-sm text-destructive">{t('share.loadError')}</p>
        ) : (
          <div className="flex flex-col gap-5">
            {/* In-browser workspace disclosure (P0-4): nothing outside this
                browser can reach the workspace, so these settings can't take
                effect for anyone else — supersedes the claim disclosures below
                (which presuppose a reachable instance). */}
            {browserLocal && (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                {t('share.browserLocalNotice')}
              </p>
            )}

            {/* Pre-claim disclosure: on a *confirmed* unclaimed instance these
                settings are saved but inert (rule-0 short-circuit), so we say so
                plainly. Hidden until the claim lookup resolves (F1); announced
                politely so SR users hear it appear after the async resolve (F2). */}
            {!browserLocal && claimStatus === 'unclaimed' && (
              <p
                aria-live="polite"
                className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
              >
                {t('share.unclaimedNotice')}
              </p>
            )}

            {/* Visibility scope */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="share-scope">{t('share.scopeLabel')}</Label>
              <Select
                ref={scopeSelectRef}
                id="share-scope"
                aria-label={t('share.scopeLabel')}
                value={scope}
                disabled={loading || !canManage}
                wrapperClassName="w-full"
                onChange={(e) => void changeScope(e.target.value as PageVisibility)}
              >
                {scopeOptions.map((v) => (
                  <option key={v} value={v}>
                    {t(SCOPE_LABEL[v].label)}
                  </option>
                ))}
              </Select>
              {/* Reveal the power-user scopes on demand (SHR-4). Hidden once
                  expanded, and suppressed for a read-only viewer who can't change
                  the scope anyway. Moving focus to the scope Select on reveal makes
                  it obvious the picker just gained options (a11y) — keyboard users
                  land on the control they came for, not a now-vanished link. */}
              {!showAdvanced && canManage && (
                <button
                  type="button"
                  onClick={() => {
                    setShowAdvanced(true);
                    scopeSelectRef.current?.focus();
                  }}
                  className="self-start text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                >
                  {t('share.scopeAdvanced')}
                </button>
              )}
              <p className="text-xs text-muted-foreground">{t(SCOPE_LABEL[scope].hint)}</p>
              {/* What "Workspace default" resolves to right now, so `inherit` is
                  never a mystery box (SHR-6). On a CLAIMED instance that's the root
                  `defaultVisibility` (e.g. members only); only on an unclaimed one
                  does the legacy guest gate govern — reading the guest gate for a
                  claimed instance was the bug. Falls back to the guest-gate line
                  when a pre-SHR-6 server doesn't report the default. */}
              {scope === 'inherit' &&
                (claimStatus === 'claimed' && defaultVisibility !== null ? (
                  <p className="text-xs text-muted-foreground">
                    {t(`share.effectiveDefault.${defaultVisibility}`)}
                  </p>
                ) : guestAccess !== null ? (
                  <p className="text-xs text-muted-foreground">{t(`share.effective.${guestAccess}`)}</p>
                ) : null)}
              {/* The origin already enforces every scope for forwarded requests
                  too (a non-grantee 404s — fail-safe, never a leak). The real gap
                  is that a legitimate grantee can't yet *open* a restricted page
                  through its published *.book.pub link until the identity bridge
                  (D2 + OB-202) lands — caveat that, only once confirmed claimed. */}
              {!browserLocal && claimStatus === 'claimed' && scope !== 'public' && (
                <p className="text-xs text-muted-foreground">{t('share.enforcementCaveat')}</p>
              )}
              {scopeError && (
                <p role="alert" aria-live="assertive" className="text-xs text-destructive">
                  {t(scopeError)}
                </p>
              )}
            </div>

            {/* Add a person (managers only — read-only viewers still see the roster below) */}
            {canManage && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="share-invitee">{t('share.addLabel')}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="share-invitee"
                    inputSize="sm"
                    className="flex-1"
                    placeholder={t('share.addPlaceholder')}
                    value={invitee}
                    disabled={adding}
                    onChange={(e) => setInvitee(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void addPerson();
                      }
                    }}
                  />
                  <Select
                    aria-label={t('share.levelLabel')}
                    value={level}
                    inputSize="sm"
                    wrapperClassName="w-[116px]"
                    onChange={(e) => setLevel(e.target.value as AclLevel)}
                  >
                    <option value="read">{t('share.levelRead')}</option>
                    <option value="write">{t('share.levelWrite')}</option>
                  </Select>
                  <Button size="sm" onClick={() => void addPerson()} disabled={adding || !invitee.trim()}>
                    {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.add')}
                  </Button>
                </div>
                {addError && (
                  <p role="alert" aria-live="assertive" className="text-xs text-destructive">
                    {t(addError)}
                  </p>
                )}
              </div>
            )}

            {/* Current grants. The heading is a plain span, not a <Label> — it
                labels a list, not a form control, so an orphan htmlFor-less
                <Label> would be a mislabel (F6). Hidden entirely when this
                principal may not read the ACL (a read-only viewer): scope +
                the effective default still render above. */}
            {aclReadable && (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium leading-none">{t('share.peopleLabel')}</span>
                {loading ? (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('share.loadingPeople')}
                  </p>
                ) : grants.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('share.noPeople')}</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {grants.map((grant) => {
                      const {name, key} = granteeOf(grant);
                      return (
                        <li
                          key={'subject' in key ? `s:${key.subject}` : `e:${key.email}`}
                          className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5"
                        >
                          <span className="min-w-0 flex-1 truncate text-sm" title={name}>
                            {name}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {t(grant.level === 'write' ? 'share.levelWrite' : 'share.levelRead')}
                          </span>
                          {canManage && (
                            <IconButton
                              size="sm"
                              aria-label={t('share.remove', {name})}
                              title={t('share.remove', {name})}
                              onClick={() => void removePerson(grant)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </IconButton>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {/* Delivery help (P0-2): the instance invite path has NO mailer —
                adding a person writes an ACL row but notifies no one. Once the
                workspace is published we can hand the owner a real link to send
                and spell out that each invitee must sign in with the email they
                were invited as (claimMemberships binds the persona on first
                request). The unpublished-desktop case is already covered by the
                local-only copy-link hint below, and browser-local by the notice
                above — so this only appears when there's a reachable address
                AND someone still awaiting first sign-in. A subject-only grant is
                already claimed (claimMemberships re-keys email→subject on first
                sign-in) or was added by handle, so only a pending EMAIL grant
                needs the "sign in as the email you invited" hand-off — and it
                gives that sentence a concrete email referent. */}
            {canManage && !browserLocal && publishedHost && aclReadable && grants.some((g) => g.email != null) && (
              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2.5">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t('share.deliver.hint')}</p>
                <Button variant="outline" size="sm" className="shrink-0" onClick={() => void copyDeliverLink()}>
                  {deliverCopied ? (
                    <>
                      <Check className="mr-1.5 h-4 w-4" />
                      {t('share.copied')}
                    </>
                  ) : (
                    <>
                      <Link2 className="mr-1.5 h-4 w-4" />
                      {t('share.deliver.copy')}
                    </>
                  )}
                </Button>
              </div>
            )}

            {/* Workspace-level surfaces this dialog summarizes: the guest gate /
                publishing live in Settings → Sharing & publishing, the roster in
                Settings → Members. Managers get one-click paths so "who can see
                this?" never requires knowing which of four surfaces applies. */}
            {canManage && (
              <div className="flex items-center gap-4 border-t border-border pt-3 text-xs">
                <button
                  type="button"
                  className="cursor-pointer text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                  onClick={() => {
                    setOpen(false);
                    setHud((draft) => {
                      draft.settings.open = true;
                      draft.settings.tab = 'sharing';
                      return draft;
                    });
                  }}
                >
                  {t('share.manageWorkspace')}
                </button>
                <button
                  type="button"
                  className="cursor-pointer text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                  onClick={() => {
                    setOpen(false);
                    setHud((draft) => {
                      draft.settings.open = true;
                      draft.settings.tab = 'members';
                      return draft;
                    });
                  }}
                >
                  {t('share.manageMembers')}
                </button>
              </div>
            )}

            {/* Copy link — or, for a manager on an unpublished desktop, an inline
                Publish affordance (SHR-3): a dead local-only link is useless to
                copy, so drive `enable()` right here instead of pointing at Settings.
                Everywhere else the hint tells the truth about where the copied URL
                reaches: in the standalone web app it opens the recipient's OWN
                in-browser workspace, not this page (the worst lie of the batch); on
                an unpublished desktop a non-manager (who can't publish) is told it's
                local-only; once published it carries the forwarded address, so the
                per-scope hint applies — plus the address itself. */}
            {!browserLocal && linkIsLocalOnly && canManage ? (
              <InlinePublish />
            ) : (
              <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                <span className="text-xs text-muted-foreground">
                  {browserLocal ? (
                    t('share.linkHints.browserLocal')
                  ) : linkIsLocalOnly ? (
                    t('share.linkHints.localOnly')
                  ) : (
                    <>
                      {t(LINK_HINT[scope])}
                      {publishedHost && <> {t('share.linkHints.publishedAt', {host: publishedHost})}</>}
                    </>
                  )}
                </span>
                <Button variant="outline" size="sm" onClick={() => void copyLink()}>
                  {copied ? (
                    <>
                      <Check className="mr-1.5 h-4 w-4" />
                      {t('share.copied')}
                    </>
                  ) : (
                    <>
                      <Link2 className={cn('mr-1.5 h-4 w-4')} />
                      {t('share.copyLink')}
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
