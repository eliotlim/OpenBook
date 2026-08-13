import {useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {Check, Globe, Link2, Loader2, Share2, Trash2} from 'lucide-react';
import {PAGE_VISIBILITIES, type AclLevel, type GuestAccess, type InstanceInfo, type PageAcl, type PageVisibility} from '@book.dev/sdk';
import {useData} from '@/data';
import {useForwarding, useHud, useOptionalAccount, usePlatformCapabilities, useTranslation} from '@/providers';
import {DIALOG_EXIT_MS} from './ui/dialog';
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
import {Switch} from '@/components/ui/switch';
import {copyPageLink} from '@/lib/pageActions';
import {clearShareTarget, readShareTarget, shareDialogVersion, subscribeShareDialog} from '@/lib/shareDialog';
import {SiteVisibilityControl} from '@/components/SiteVisibilityControl';
import {SETTINGS_SECTION_PEOPLE} from '@/lib/hud';
import {enabledFormBlockId, formBlockReadyForSubmissions} from '@/blockeditor/formBlock';
import {openKitPanel} from '@/blockeditor/kit/kitPanel';
import type {TKey} from '@/i18n';

/** i18n label per visibility scope (escalating privacy). `inherit` is presented
 *  as "Library default" — the honest name for the unset/inherited state. */
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
 *  up front, keep `inherit` ("Library default") primary too so "reset to the
 *  library default" is always reachable, tuck only the genuinely-obscure
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
 * Inline "Publish this library" affordance (SHR-3), shown in the Share dialog when
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
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('forwarding.registering')}
          </>
        ) : (
          <>
            <Share2 className="h-4 w-4" />
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

/** Render `msg` with the (unbreakable) host segment allowed to break mid-token. */
function HostHint({msg, host}: {msg: string; host: string}) {
  const i = msg.indexOf(host);
  if (i < 0) return <span className="break-all">{msg}</span>;
  return <>{msg.slice(0, i)}<span className="break-all">{host}</span>{msg.slice(i + host.length)}</>;
}

type FormReachability =
  | {key: TKey; host?: undefined}
  | {key: 'share.forms.reachability.liveAt'; host: string};

/** Enabled-form disclosure: capability state, actual signed-out reachability,
 * and the two owner paths that can change those facts. */
function FormSubmissionRow({
  ready,
  reachability,
  guestOff,
  canManage,
  onOpenSettings,
  onManageGuestAccess,
}: {
  ready: boolean;
  reachability: FormReachability;
  guestOff: boolean;
  canManage: boolean;
  onOpenSettings: () => void;
  onManageGuestAccess: () => void;
}) {
  const {t} = useTranslation();
  if (!ready) {
    return (
      <div
        data-form-public-submissions
        data-form-not-ready
        aria-live="polite"
        className="flex items-start justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
      >
        <span>{t('share.forms.notReady')}</span>
        {canManage && (
          <button
            type="button"
            className="shrink-0 underline underline-offset-2 hover:text-foreground"
            onClick={onOpenSettings}
          >
            {t('share.forms.settings')}
          </button>
        )}
      </div>
    );
  }
  const reachabilityText = reachability.host
    ? t(reachability.key, {host: reachability.host})
    : t(reachability.key);
  return (
    <div data-form-public-submissions className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-xs font-medium text-foreground">{t('share.forms.accepts')}</span>
          <span className="block text-xs text-muted-foreground">
            {reachability.host
              ? <HostHint msg={reachabilityText} host={reachability.host} />
              : reachabilityText}
          </span>
        </span>
        {canManage && (
          <button
            type="button"
            className="shrink-0 text-xs text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
            onClick={onOpenSettings}
          >
            {t('share.forms.settings')}
          </button>
        )}
      </div>
      {guestOff && (
        <div
          aria-live="polite"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground"
        >
          {t('share.forms.guestOffCaveat')}
          {canManage && (
            <>
              {' '}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground"
                onClick={onManageGuestAccess}
              >
                {t('share.forms.manageGuestAccess')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The per-page "Publish to the web" affordance (GATE-6). Four states, all under a
 * reachable published address:
 *   - `live` — the page resolves to `public`, the address serves public pages, AND
 *     the instance guest gate admits signed-out reads, so it's genuinely open at the
 *     site address: a "Published" indicator with the address.
 *   - `guestOff` — the page + address both say public, but the instance guest gate is
 *     `off`, so signed-out visitors still can't read it. Instead of claiming
 *     "Published" (a lie) or rendering nothing, show the amber guest-off caveat that
 *     explains why the page isn't reachable and where to fix it.
 *   - `canPublish` (page not yet public) — a primary "Publish page" button that
 *     flips the page to `public` in one click (immediately live when the address is
 *     "Only published pages"/"Public", which a new site now defaults to).
 *   - neither (page public but the address doesn't serve it) — renders nothing; the
 *     address-mismatch notice below the scope picker owns that case.
 */
function PublishRow({
  live,
  canPublish,
  guestOff,
  host,
  busy,
  onPublish,
}: {
  live: boolean;
  canPublish: boolean;
  guestOff: boolean;
  host: string;
  busy: boolean;
  onPublish: () => void;
}) {
  const {t} = useTranslation();
  if (live) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2.5">
        <Globe className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-medium text-foreground">{t('share.publishState.live')}</span>
          <span className="text-xs text-muted-foreground">
            <HostHint msg={t('share.publishState.liveHint', {host})} host={host}/>
          </span>
        </span>
      </div>
    );
  }
  // Scope + address both resolve public, but the guest gate is closed — a signed-out
  // visitor still 404s. Explain the one thing the publish flow can't paper over
  // (reusing the SiteVisibilityControl caveat idiom) rather than under-/over-claiming.
  // Deliberately the PUBLISHED-intent variant (not `guestOffCaveatPublic`): the owner
  // is publishing ONE page here, so the honest minimum fix is per-page publishing —
  // never widening the whole library to "Anyone can view".
  if (guestOff) {
    return (
      <p
        aria-live="polite"
        className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs text-foreground"
      >
        {t('forwarding.visibility.guestOffCaveat')}
      </p>
    );
  }
  if (!canPublish) return null;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 px-3 py-2.5">
      <p className="text-xs text-muted-foreground">
        <HostHint msg={t('share.publishState.hint', {host})} host={host}/>
      </p>
      <Button size="sm" className="self-start" disabled={busy} onClick={onPublish}>
        <Globe className="h-4 w-4" />
        {t('share.publishState.action')}
      </Button>
    </div>
  );
}

/**
 * The per-page Share dialog (OB-203) — the hub for "who can access this page".
 * A manager sets the page's audience-scope visibility and grants individual
 * people read/edit access by email, all against the OB-191 per-page
 * API (`setPageVisibility`, `sharePage`/`listPageAcl`/`unsharePage`); it also
 * shows the *effective* library default behind `inherit` and links out to
 * the library-level Sharing tab (its top, and its People roster section). A non-manager
 * (`canManage: false`) gets the same dialog read-only. Production entry points
 * all target the single app-shell {@link ShareDialogHost}.
 */
export default function ShareDialog({
  pageId,
  canManage = true,
  open: openProp,
  onOpenChange,
  showTrigger = true,
}: {
  pageId: string;
  canManage?: boolean;
  /** Controlled open state — when provided, the dialog is driven by the caller
   *  (e.g. the {@link ShareDialogHost} opened from a menu/command) instead of its
   *  own trigger. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Whether to render the built-in Share IconButton trigger (default). The
   *  host opens the dialog imperatively, so it hides the trigger. */
  showTrigger?: boolean;
}) {
  const client = useData();
  const {t} = useTranslation();
  const {setHud} = useHud();

  // Where a copied link actually reaches (P0-1). On a desktop build
  // (`supported`), the link is `tauri://localhost` — dead off this device —
  // UNLESS the library is published, in which case `pageLinkUrl` emits the
  // forwarded host (`publishedHost` is the same predicate that drives the
  // share-link origin registration in ForwardingProvider).
  const {supported: canPublish, publishedHost, siteVisibility, siteVisibilityBusy, setSiteVisibility} = useForwarding();
  const linkIsLocalOnly = canPublish && !publishedHost;
  // The standalone web app's in-browser store (P0-4): the library lives only in
  // this browser profile, so nothing set here can reach another person and a
  // copied link opens the *recipient's own* library, not this page. The dialog
  // stays functional (settings persist) but must say so.
  const browserLocal = usePlatformCapabilities().browserLocalLibrary === true;

  // Uncontrolled fallback: used only when the caller doesn't drive `open`.
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const [scope, setScope] = useState<PageVisibility>('inherit');
  // Older servers omit the discovery flag, which means their historical
  // behaviour is listed. The authoritative value replaces this on each open.
  const [listed, setListed] = useState(true);
  const [listingBusy, setListingBusy] = useState(false);
  const [listingError, setListingError] = useState<TKey | null>(null);
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
  // The library guest gate — what `inherit` resolves to on an *unclaimed*
  // instance (rule-0 short-circuit). `null` until the instance lookup lands.
  const [guestAccess, setGuestAccess] = useState<GuestAccess | null>(null);
  // The root default scope `inherit` resolves to once *claimed* (SHR-6). `null`
  // until the lookup lands, or on a pre-SHR-6 server that doesn't report it — in
  // which case the summary falls back to the guest-gate line below.
  const [defaultVisibility, setDefaultVisibility] = useState<Exclude<PageVisibility, 'inherit'> | null>(null);
  // The helper returns the ID only, never the submission capability. Readiness
  // is a separate boolean so an enabled/keyed but unbound form gets an honest
  // amber setup state instead of an affirmative public-submission claim.
  const [formDisclosure, setFormDisclosure] = useState<{blockId: string; ready: boolean} | null>(null);

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
      const settings = await client.getPageVisibility(pageId);
      setScope(settings?.visibility ?? 'inherit');
      setListed(settings?.listed ?? true);
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
    setListingError(null);
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

  // Read the same authoritative blockdoc projection as the server capability
  // gate. Form discovery is informational: a failed page read leaves the line
  // hidden without breaking the rest of sharing.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setFormDisclosure(null);
    client
      .getPage(pageId)
      .then((page) => {
        if (!live || !page) return;
        const blockId = enabledFormBlockId(page.data);
        setFormDisclosure(blockId ? {
          blockId,
          ready: formBlockReadyForSubmissions(page.data, blockId),
        } : null);
      })
      .catch(() => {
        /* leave the form disclosure hidden — sharing remains usable */
      });
    return () => {
      live = false;
    };
  }, [client, open, pageId]);

  const changeScope = useCallback(
    async (next: PageVisibility) => {
      const prev = scope;
      setScope(next); // optimistic
      setScopeError(null);
      try {
        await client.setPageVisibility(pageId, {visibility: next});
      } catch (e) {
        setScope(prev); // revert on failure
        setScopeError(shareErrorKey(e)); // …and surface why (F2)
      }
    },
    [client, pageId, scope],
  );

  const changeHidden = useCallback(
    async (hidden: boolean) => {
      const prev = listed;
      setListed(!hidden); // optimistic: the control is phrased as "Hide"
      setListingBusy(true);
      setListingError(null);
      try {
        const saved = await client.setPageVisibility(pageId, {listed: !hidden});
        setListed(saved.listed);
      } catch (e) {
        setListed(prev);
        setListingError(shareErrorKey(e));
      } finally {
        setListingBusy(false);
      }
    },
    [client, listed, pageId],
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

  // The scope that ACTUALLY governs at the edge: `inherit` defers to the resolved
  // library default (SHR-6), so an inherited-public page hits the same
  // site-visibility mismatch as an explicitly-public one — the notice must cover
  // both (Quinn). `null` until the default resolves, in which case it can't fire.
  const effectiveScope = scope === 'inherit' ? defaultVisibility : scope;
  const publishedAddressHint = publishedHost ? t('share.linkHints.publishedAt', {host: publishedHost}) : '';
  const siteServesPublicPages = siteVisibility === 'public' || siteVisibility === 'published';
  const formHasPublicAddress = effectiveScope === 'public' && (
    (publishedHost !== null && siteServesPublicPages)
    || (canPublish === false && !browserLocal)
  );
  // Same guest-gate truth surfaced by SiteVisibilityControl: even a public page
  // at an address that serves it returns 404 to signed-out visitors when the
  // origin's guest gate is off.
  const showFormGuestCaveat = guestAccess === 'off' && formHasPublicAddress;
  const formReachability: FormReachability = browserLocal
    ? {key: 'share.forms.reachability.browserLocal'}
    : effectiveScope === null
      ? {key: 'share.forms.reachability.checking'}
      : effectiveScope !== 'public'
        ? {key: 'share.forms.reachability.pageLimited'}
        : canPublish && !publishedHost
          ? {key: 'share.forms.reachability.unpublished'}
          : publishedHost && siteVisibility === null
            ? {key: 'share.forms.reachability.checking'}
            : publishedHost && !siteServesPublicPages
              ? {key: 'share.forms.reachability.addressLimited'}
              : guestAccess === 'off'
                ? {key: 'share.forms.reachability.guestBlocked'}
                : publishedHost
                  ? {key: 'share.forms.reachability.liveAt', host: publishedHost}
                  : {key: 'share.forms.reachability.live'};

  const openFormSettings = useCallback(() => {
    if (!formDisclosure) return;
    setOpen(false);
    window.setTimeout(() => openKitPanel(formDisclosure.blockId, t('formBlock.label')), DIALOG_EXIT_MS);
  }, [formDisclosure, setOpen, t]);

  const openGuestAccessSettings = useCallback(() => {
    setOpen(false);
    setHud((draft) => {
      draft.settings.open = true;
      draft.settings.tab = 'sharing';
      draft.settings.section = null;
      return draft;
    });
  }, [setHud, setOpen]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* The showTrigger/openState path is exercised only by unit tests; production
          always mounts via ShareDialogHost with showTrigger={false} open. */}
      {showTrigger && (
        <DialogTrigger asChild>
          <IconButton size="sm" aria-label={t('share.open')} title={t('share.open')}>
            <Share2 className="h-4 w-4" />
          </IconButton>
        </DialogTrigger>
      )}
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t('share.title')}</DialogTitle>
          <DialogDescription>{t(canManage ? 'share.description' : 'share.readOnlyDescription')}</DialogDescription>
        </DialogHeader>

        {loadError ? (
          <p className="text-sm text-destructive">{t('share.loadError')}</p>
        ) : (
          <div className="min-w-0 flex flex-col gap-5">
            {/* grid-item min-width guard — the real overflow fix; a base-level min-w-0 on DialogContent does NOT subsume this */}
            {/* In-browser library disclosure (P0-4): nothing outside this
                browser can reach the library, so these settings can't take
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

            {/* Publish to the web (GATE-6): the clear, primary "make this page
                reachable at your site address" affordance, plus a live indicator
                once it is. Shown only while THIS device is actually publishing
                (`publishedHost`) and the viewer manages sharing. "Published" means
                the page resolves to `public` AND the address serves public pages to
                signed-out visitors (`public`/`published` scope) AND the instance
                guest gate isn't `off` (a closed gate 404s signed-out reads even at an
                open address — surfaced inline as the guest-off caveat); short of that,
                the address-mismatch notice further down guides the fix. Publishing is a
                one-click scope→public because a new site's address now defaults to
                "Only published pages", so a public page is immediately live. */}
            {canManage && !browserLocal && publishedHost && (
              <PublishRow
                live={
                  effectiveScope === 'public' &&
                  (siteVisibility === 'public' || siteVisibility === 'published') &&
                  guestAccess !== 'off'
                }
                canPublish={effectiveScope !== 'public'}
                guestOff={
                  effectiveScope === 'public' &&
                  (siteVisibility === 'public' || siteVisibility === 'published') &&
                  guestAccess === 'off'
                }
                host={publishedHost}
                busy={loading}
                onPublish={() => void changeScope('public')}
              />
            )}

            {/* Discovery is independent from access. Keep the setting visible at
                the private end of the scope ladder so a stored hidden posture is
                legible, but disable it where navigation/search have no link-based
                discovery relevance. `inherit` remains page-local and available. */}
            {canManage && (
              <div className="rounded-md border border-border bg-muted/40 px-3 py-2.5">
                <label className="flex items-center justify-between gap-4">
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium text-foreground">{t('share.listing.label')}</span>
                    <span className="text-xs text-muted-foreground">
                      {t(
                        scope === 'inherit'
                          ? 'share.listing.inheritHint'
                          : scope === 'restricted'
                            ? 'share.listing.restrictedHint'
                            : 'share.listing.hint',
                      )}
                    </span>
                  </span>
                  <Switch
                    checked={!listed}
                    disabled={loading || listingBusy || scope === 'restricted'}
                    aria-label={t('share.listing.label')}
                    onCheckedChange={(hidden) => void changeHidden(hidden)}
                  />
                </label>
                {listingError && (
                  <span role="alert" aria-live="assertive" className="mt-1.5 block text-xs text-destructive">
                    {t(listingError)}
                  </span>
                )}
              </div>
            )}

            {formDisclosure && (
              <FormSubmissionRow
                ready={formDisclosure.ready}
                reachability={formReachability}
                guestOff={showFormGuestCaveat}
                canManage={canManage}
                onOpenSettings={openFormSettings}
                onManageGuestAccess={openGuestAccessSettings}
              />
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
              {/* What "Library default" resolves to right now, so `inherit` is
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

            {/* Published-address audience scope (SHR-8 / GATE-5). The *.book.cloud
                address carries its OWN scope on the account. Two scopes serve a
                public page to signed-out visitors: "Only published pages"
                (`published` — the recommended default, exposes only pages you
                publish) and "Public" (`public` — the whole library). So the "your
                link is a lie" mismatch only remains when the address is Private /
                signed-in-only (`restricted`/`authenticated`/`members`) — there we
                call it out and offer the one-click recommended fix (turn on
                published-pages). Owner-only + only while this device is actually
                publishing (`publishedHost`). */}
            {canManage && publishedHost && siteVisibility && (
              <div className="flex flex-col gap-2">
                {effectiveScope === 'public' &&
                  siteVisibility !== 'public' &&
                  siteVisibility !== 'published' && (
                  <div
                    aria-live="polite"
                    className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2"
                  >
                    {/* A "your link is silently bounced" warning must not read
                          low-priority — full-contrast body (not muted) on the caution
                          surface, with the one-click recommended fix right here. */}
                    <p className="text-xs text-foreground">{t('share.siteRestrictedNotice')}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="self-start"
                      disabled={siteVisibilityBusy}
                      onClick={() => void setSiteVisibility('published')}
                    >
                      {t('share.makeSitePublished')}
                    </Button>
                  </div>
                )}
                <SiteVisibilityControl />
                {/* The address scope is library-global, not per-page — say so here,
                    in a per-page dialog, so it isn't misread as this page only (Devon F4). */}
                <p className="text-xs text-muted-foreground">{t('share.siteGlobalHint')}</p>
              </div>
            )}

            {/* Add a person (managers only — read-only viewers still see the roster below) */}
            {canManage && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="share-invitee">{t('share.addLabel')}</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id="share-invitee"
                    inputSize="sm"
                    className="min-w-40 flex-1"
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
                  <Button size="xs" onClick={() => void addPerson()} disabled={adding || !invitee.trim()}>
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
                library is published we can hand the owner a real link to send
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
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => void copyDeliverLink()}
                >
                  {deliverCopied ? (
                    <>
                      <Check className="h-4 w-4" />
                      {t('share.copied')}
                    </>
                  ) : (
                    <>
                      <Link2 className="h-4 w-4" />
                      {t('share.deliver.copy')}
                    </>
                  )}
                </Button>
              </div>
            )}

            {/* Library-level surfaces this dialog summarizes, all now on the one
                Sharing tab (SHR-5): the guest gate / publishing at its top, the
                member roster in its People section. Managers get one-click paths so
                "who can see this?" never requires knowing which surface applies. */}
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
                      draft.settings.section = null;
                      return draft;
                    });
                  }}
                >
                  {t('share.manageLibrary')}
                </button>
                <button
                  type="button"
                  className="cursor-pointer text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground"
                  onClick={() => {
                    setOpen(false);
                    setHud((draft) => {
                      draft.settings.open = true;
                      draft.settings.tab = 'sharing';
                      draft.settings.section = SETTINGS_SECTION_PEOPLE;
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
                in-browser library, not this page (the worst lie of the batch); on
                an unpublished desktop a non-manager (who can't publish) is told it's
                local-only; once published it carries the forwarded address, so the
                per-scope hint applies — plus the address itself. */}
            {!browserLocal && linkIsLocalOnly && canManage ? (
              <InlinePublish />
            ) : (
              <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                  {browserLocal ? (
                    t('share.linkHints.browserLocal')
                  ) : linkIsLocalOnly ? (
                    t('share.linkHints.localOnly')
                  ) : (
                    <>
                      {t(LINK_HINT[scope])}
                      {!listed && scope !== 'restricted' && (
                        <> {t('share.linkHints.hidden')}</>
                      )}
                      {publishedHost && (
                        <>
                          {' '}
                          <HostHint msg={publishedAddressHint} host={publishedHost}/>
                        </>
                      )}
                    </>
                  )}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => void copyLink()}
                >
                  {copied ? (
                    <>
                      <Check className="h-4 w-4" />
                      {t('share.copied')}
                    </>
                  ) : (
                    <>
                      <Link2 className="h-4 w-4" />
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

/**
 * The single mounted host that opens the Share dialog imperatively — driven by
 * the {@link requestShareDialog} store so the toolbar, publish indicator,
 * command palette, and page "…" menu share one open state. Renders nothing
 * until a page is targeted, and only when the server actually supports sharing.
 * Mounted once in the app shell (see DefaultLayout).
 */
export function ShareDialogHost() {
  useSyncExternalStore(subscribeShareDialog, shareDialogVersion, shareDialogVersion);
  const target = readShareTarget();
  const [retainedTarget, setRetainedTarget] = useState(target);
  const {supported, canManage} = useSharingCapability();
  useEffect(() => {
    if (target !== null) {
      setRetainedTarget(target);
      return;
    }
    if (retainedTarget === null) return;
    // Keep Radix mounted through dialog.tsx's duration-200 exit animation; its
    // presence/focus scope can then restore focus before the retained page clears.
    const timeout = window.setTimeout(() => setRetainedTarget(null), DIALOG_EXIT_MS);
    return () => window.clearTimeout(timeout);
  }, [retainedTarget, target]);
  const renderedTarget = target ?? retainedTarget;
  // Unsupported servers have no Share dialog to show; the menu/command entries
  // stay visible-but-disabled, so a stray request here is simply a no-op.
  if (!renderedTarget || supported === false) return null;
  return (
    <ShareDialog
      key={renderedTarget}
      pageId={renderedTarget}
      canManage={canManage}
      showTrigger={false}
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) clearShareTarget();
      }}
    />
  );
}
