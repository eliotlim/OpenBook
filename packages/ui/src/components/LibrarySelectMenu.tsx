import {useState} from 'react';
import {getServerUrlOverride, setServerUrlOverride, isMixedContentBlocked} from '@book.dev/sdk';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import LibraryInfo from '@/components/LibraryInfo';
import {IconPicker} from '@/components/IconPicker';
import {ChevronUpDownIcon, Cog6ToothIcon, PlusIcon} from '@heroicons/react/24/outline';
import {CheckIcon, GlobeIcon} from '@radix-ui/react-icons';
import {Trash2, Cloud} from 'lucide-react';
import {LibraryStatusDot} from '@/components/LibraryStatusDot';
import {
  usePlatformCapabilities,
  useTranslation,
  useLibrary,
  useHud,
  useOptionalAccount,
  isSafeServerUrl,
  libraryHostLabel,
  type Library,
} from '@/providers';

/**
 * The library switcher. `variant` controls the trigger only:
 *  - `sidebar` (default) — the full-width, two-line button at the top of the
 *    sidebar (web);
 *  - `titlebar` — a compact icon + name button for the desktop titlebar.
 * The dropdown contents (library list + "connect to a library") are identical.
 *
 * Connect (LM-3): "Connect to a library…" opens the add-a-server dialog; on
 * submit it adds the server AND switches this device onto it (reload-switch),
 * enforcing the safe-URL + mixed-content guards.
 *
 * Discovery (LM-4): when signed in, the libraries synced to the account are shown
 * under a "From your account" group — including ones configured on another device
 * that aren't local here yet, which connect with a single click.
 */
export default function LibrarySelectMenu({variant = 'sidebar'}: {variant?: 'sidebar' | 'titlebar'}) {
  const {libraries, library, selectLibrary, addLibrary, removeLibrary} = useLibrary();
  const {setHud} = useHud();
  const {t} = useTranslation();
  // Account is optional chrome — degrade (no "From your account" group) rather
  // than crash if this ever renders outside an AccountProvider.
  const account = useOptionalAccount();
  // On a forwarded `<prefix>.book.cloud` site the app talks to the owner's
  // instance same-origin, so the local/default library (no server override)
  // has no host to name itself after — label it with the site host instead of
  // the generic "My Library".
  // On the sidecar-served LAN UI (STAB-9) the local library is the host's,
  // reached over the network — so its "This device" connection label is wrong
  // for a guest. Show a context-neutral "Local network" instead.
  const {forwardedHost, servedSameOrigin} = usePlatformCapabilities();
  const isForwardedLocal = (ws: {serverUrl: string | null}): boolean =>
    Boolean(forwardedHost) && ws.serverUrl === null;
  const servedLocalLabel = (ws: {serverUrl: string | null}): string | undefined =>
    servedSameOrigin && ws.serverUrl === null ? t('library.localNetwork') : undefined;
  const nameFor = (ws: {serverUrl: string | null; name: string}): string =>
    isForwardedLocal(ws) ? forwardedHost! : ws.name;

  const [addOpen, setAddOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [name, setName] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [icon, setIcon] = useState('');
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setName('');
    setServerUrl('');
    setIcon('');
    setError(null);
  };

  const closeAdd = () => {
    setAddOpen(false);
    resetForm();
  };

  // Add a server to the list AND switch this device onto it, mirroring
  // `selectLibrary`'s in-place server re-point (no full reload). `addLibrary`
  // persists the named entry; re-pointing the shared override fans out to the app
  // shell (onServerOverrideChange), which swaps the data client and remounts the
  // data subtree so the switch takes effect without a `window.location.reload`.
  const connectTo = (url: string, meta: {name?: string; icon?: string}) => {
    const lib = addLibrary({name: meta.name ?? '', serverUrl: url, icon: meta.icon});
    // Already talking to this server — no re-point needed; just reflect it.
    if ((url || null) === getServerUrlOverride()) {
      selectLibrary(lib.id);
      return;
    }
    setServerUrlOverride(url);
  };

  const submitConnect = () => {
    const url = serverUrl.trim();
    if (!url) {
      setError(t('library.urlRequired'));
      return;
    }
    // Reject anything that isn't a well-formed http(s) URL before it can re-point
    // the data client (a poisoned/typo'd scheme never reaches the connection).
    if (!isSafeServerUrl(url)) {
      setError(t('library.urlUnsafe'));
      return;
    }
    // An https app can't reach a plain http:// LAN address — block it with an
    // explanation rather than let it fail with an opaque browser error.
    if (isMixedContentBlocked(url)) {
      setError(t('library.mixedContentBlocked'));
      return;
    }
    connectTo(url, {name, icon});
    closeAdd();
  };

  // ── Group the switcher list (LM-4). ─────────────────────────────────────────
  // The active account's synced libraries (empty when signed out). The local
  // device library (serverUrl null) is always "on this device", never surfaced as
  // an account library even though the sync blob carries it.
  const synced = account?.syncedLibraries ?? [];
  const accountRemotes = synced.filter((l) => l.serverUrl !== null && isSafeServerUrl(l.serverUrl));
  const accountUrls = new Set(accountRemotes.map((l) => l.serverUrl));
  const hasAccountGroup = accountRemotes.length > 0;
  // "On this device" when grouped: the device library + any remote added locally
  // that the account doesn't (yet) know about.
  const localOnly = libraries.filter((l) => l.serverUrl === null || !accountUrls.has(l.serverUrl));
  // The account group: prefer the matching local entry (so its id/icon/status are
  // the live ones) and fall back to the synced entry, which then connects on click.
  const accountRows = accountRemotes.map((s) => {
    const local = libraries.find((l) => l.serverUrl === s.serverUrl);
    return {lib: local ?? s, local: Boolean(local), synced: true};
  });

  const onSelectRow = (row: {lib: Library; local: boolean}) => {
    if (row.local) {
      selectLibrary(row.lib.id);
      return;
    }
    if (row.lib.serverUrl && !isMixedContentBlocked(row.lib.serverUrl)) {
      connectTo(row.lib.serverUrl, {name: row.lib.name, icon: row.lib.icon});
    }
  };

  const renderRow = (row: {lib: Library; local: boolean; synced?: boolean}) => {
    const ws = row.lib;
    const active = row.local && ws.id === library.id;
    const canRemove = row.local && !active && libraries.length > 1;
    const blocked = !row.local && Boolean(ws.serverUrl) && isMixedContentBlocked(ws.serverUrl!);
    // A synced library that's already connected here would otherwise read as a
    // plain local row — mark it so its account provenance stays legible per-row.
    const showSyncedCue = Boolean(row.synced) && row.local;
    return (
      <DropdownMenuItem
        key={`${row.local ? 'local' : 'acct'}:${ws.id}`}
        // Not `disabled`: that suppresses hover + keyboard focus, so the greyed
        // row's reason would be unreachable. `aria-disabled` keeps it focusable
        // and hoverable while `onSelect` below blocks the actual connect.
        aria-disabled={blocked || undefined}
        onSelect={(e) => {
          if (blocked) {
            e.preventDefault();
            return;
          }
          onSelectRow(row);
        }}
        onKeyDown={(e) => {
          if (canRemove && (e.key === 'Delete' || e.key === 'Backspace')) {
            e.preventDefault();
            e.stopPropagation();
            removeLibrary(ws.id);
          }
        }}
        className={`group flex items-center gap-2${blocked ? ' opacity-60' : ''}`}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center text-lg leading-none">{ws.icon}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm">{nameFor(ws)}</span>
            {showSyncedCue && (
              <span
                className="flex shrink-0 items-center text-muted-foreground"
                title={t('library.accountSyncedHint')}
                aria-label={t('library.accountSyncedHint')}
              >
                <Cloud className="h-3 w-3" aria-hidden="true" />
              </span>
            )}
          </span>
          {!isForwardedLocal(ws) && (
            <span className="truncate text-xs text-muted-foreground">
              {servedLocalLabel(ws) ?? libraryHostLabel(ws.serverUrl)}
            </span>
          )}
          {blocked && (
            // The "why" for the greyed row — always visible, not truncated, so it
            // reaches mouse and keyboard users alike.
            <span className="mt-0.5 text-xs text-muted-foreground">{t('library.mixedContentBlocked')}</span>
          )}
        </span>
        {active ? (
          <CheckIcon className="h-4 w-4 shrink-0 text-brand" />
        ) : row.local ? (
          <LibraryStatusDot serverUrl={ws.serverUrl} active={false} className="mr-1" />
        ) : blocked ? null : (
          // A synced library not connected here yet — a one-click connect.
          <span className="shrink-0 text-xs font-medium text-brand">{t('library.connectFromAccount')}</span>
        )}
        {canRemove && (
          <button
            type="button"
            aria-label={t('library.removeLibrary', {name: ws.name})}
            title={t('common.remove')}
            className="pointer-events-none flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-[color,background-color,opacity] hover:bg-hover hover:text-destructive group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              removeLibrary(ws.id);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </DropdownMenuItem>
    );
  };

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          {variant === 'titlebar' ? (
            <Button
              variant="ghost"
              className="flex h-7 max-w-[200px] items-center gap-1.5 px-2"
              onContextMenu={(event) => {
                event.preventDefault();
                setMenuOpen(true);
              }}
            >
              {library.icon ? (
                <span className="shrink-0 text-base leading-none">{library.icon}</span>
              ) : (
                <GlobeIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate text-sm font-medium">{nameFor(library)}</span>
              <ChevronUpDownIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </Button>
          ) : (
            <Button variant="ghost" className="flex h-12 w-full justify-start gap-1 px-2">
              <LibraryInfo
                icon={library.icon}
                name={nameFor(library)}
                url={isForwardedLocal(library) ? forwardedHost! : library.serverUrl ?? ''}
                subtitle={servedLocalLabel(library)}
              />
              <ChevronUpDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          {hasAccountGroup ? (
            <>
              <DropdownMenuLabel>{t('library.onThisDevice')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {localOnly.map((lib) => renderRow({lib, local: true}))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t('library.fromAccount')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {accountRows.map(renderRow)}
            </>
          ) : (
            <>
              <DropdownMenuLabel>{t('library.libraries')}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {libraries.map((lib) => renderRow({lib, local: true}))}
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              resetForm();
              setAddOpen(true);
            }}
          >
            <PlusIcon className="mr-2 h-4 w-4" />
            {t('library.connectAction')}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              setHud((draft) => {
                draft.settings.open = true;
                draft.settings.tab = 'libraries';
                return draft;
              });
            }}
          >
            <Cog6ToothIcon className="mr-2 h-4 w-4" />
            {t('library.manage')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={addOpen} onOpenChange={(open) => (open ? setAddOpen(true) : closeAdd())}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t('library.connectTitle')}</DialogTitle>
            <DialogDescription>{t('library.connectDescription')}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-1">
            <div className="flex gap-3">
              <div className="flex w-16 flex-col gap-1.5">
                <Label htmlFor="ws-icon">{t('library.icon')}</Label>
                <IconPicker
                  id="ws-icon"
                  value={icon}
                  onPick={setIcon}
                  fallback="📓"
                  ariaLabel={t('library.icon')}
                  className="flex h-control-md items-center justify-center rounded-md border border-input bg-transparent text-lg transition-colors hover:bg-hover"
                />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label htmlFor="ws-name">{t('library.name')}</Label>
                <Input
                  id="ws-name"
                  value={name}
                  placeholder={t('library.namePlaceholder')}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ws-url">{t('library.serverUrl')}</Label>
              <Input
                id="ws-url"
                value={serverUrl}
                placeholder={t('library.urlPlaceholder')}
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                onChange={(e) => {
                  setServerUrl(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && submitConnect()}
              />
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeAdd}>
              {t('common.cancel')}
            </Button>
            <Button onClick={submitConnect}>{t('library.connectButton')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
