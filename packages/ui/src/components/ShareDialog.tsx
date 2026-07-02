import {useCallback, useEffect, useState} from 'react';
import {Check, Link2, Loader2, Share2, Trash2} from 'lucide-react';
import {PAGE_VISIBILITIES, type AclLevel, type GuestAccess, type InstanceInfo, type PageAcl, type PageVisibility} from '@book.dev/sdk';
import {useData} from '@/data';
import {useHud, useTranslation} from '@/providers';
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
  if (youRole === 'admin') return true;
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

  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<PageVisibility>('inherit');
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
  // The workspace guest gate — what `inherit` actually resolves to right now.
  // `null` until the instance lookup lands (the line simply stays hidden).
  const [guestAccess, setGuestAccess] = useState<GuestAccess | null>(null);

  const [invitee, setInvitee] = useState('');
  const [level, setLevel] = useState<AclLevel>('read');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<TKey | null>(null);
  const [scopeError, setScopeError] = useState<TKey | null>(null);
  const [copied, setCopied] = useState(false);

  // Whether the roster loaded (the ACL GET is write-gated server-side, so a
  // read-only viewer gets a 403 — degrade to scope-only rather than erroring
  // the whole dialog they were just granted access to).
  const [aclReadable, setAclReadable] = useState(true);

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
            {/* Pre-claim disclosure: on a *confirmed* unclaimed instance these
                settings are saved but inert (rule-0 short-circuit), so we say so
                plainly. Hidden until the claim lookup resolves (F1); announced
                politely so SR users hear it appear after the async resolve (F2). */}
            {claimStatus === 'unclaimed' && (
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
                id="share-scope"
                aria-label={t('share.scopeLabel')}
                value={scope}
                disabled={loading || !canManage}
                wrapperClassName="w-full"
                onChange={(e) => void changeScope(e.target.value as PageVisibility)}
              >
                {PAGE_VISIBILITIES.map((v) => (
                  <option key={v} value={v}>
                    {t(SCOPE_LABEL[v].label)}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">{t(SCOPE_LABEL[scope].hint)}</p>
              {/* What "Workspace default" resolves to right now, so `inherit`
                  is never a mystery box (the effective-access summary). */}
              {scope === 'inherit' && guestAccess !== null && (
                <p className="text-xs text-muted-foreground">{t(`share.effective.${guestAccess}`)}</p>
              )}
              {/* The origin already enforces every scope for forwarded requests
                  too (a non-grantee 404s — fail-safe, never a leak). The real gap
                  is that a legitimate grantee can't yet *open* a restricted page
                  through its published *.book.pub link until the identity bridge
                  (D2 + OB-202) lands — caveat that, only once confirmed claimed. */}
              {claimStatus === 'claimed' && scope !== 'public' && (
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

            {/* Copy link */}
            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <span className="text-xs text-muted-foreground">{t(LINK_HINT[scope])}</span>
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
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
