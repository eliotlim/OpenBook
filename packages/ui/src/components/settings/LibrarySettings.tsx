import {useState} from 'react';
import {Trash2} from 'lucide-react';
import {PlusIcon} from '@heroicons/react/24/outline';
import {
  setServerUrlOverride,
  getServerTokenOverride,
  setServerTokenOverride,
  isMixedContentBlocked,
} from '@book.dev/sdk';
import {
  useTranslation,
  useLibrary,
  useConfirm,
  isSafeServerUrl,
  libraryHostLabel,
  type Library,
} from '@/providers';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {IconPicker} from '@/components/IconPicker';
import {LibraryStatusDot} from '@/components/LibraryStatusDot';
import {SettingsScreen, SettingsSection, SettingsField} from '@/components/settings/primitives';
import {cn} from '@/lib/utils';

/**
 * One editable library row — the one place to set a server (SET2-1 folded the old
 * Connection tab in here). Name and icon commit live; the server URL commits on
 * blur (or Enter) so a half-typed value never re-points the connection, and an
 * unsafe/malformed URL is rejected inline. Editing the URL no longer force-reloads
 * the app: the ACTIVE remote library gets an explicit Reconnect button (with the
 * access-token field beside it), so the reconnect is intentional. The local
 * library (`serverUrl: null`) is this device — its URL is locked and unremovable.
 */
function LibraryRow({library, active}: {library: Library; active: boolean}) {
  const {t} = useTranslation();
  const {updateLibrary, removeLibrary} = useLibrary();
  const confirm = useConfirm();
  const isLocal = library.serverUrl === null;
  // The connection controls (token + Reconnect) belong on the active remote row:
  // the access token is a single device-global override that only applies to the
  // server this device is actually talking to.
  const isConnection = active && !isLocal;

  const [nameDraft, setNameDraft] = useState(library.name);
  const [urlDraft, setUrlDraft] = useState(library.serverUrl ?? '');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState(() => getServerTokenOverride() ?? '');

  // Commit the name on blur (not per keystroke) so a half-cleared field never
  // leaves a nameless card/switcher row. Blank falls back the same way
  // `addLibrary` does — the host label, or "Local library" for this device.
  const commitName = () => {
    const trimmed = nameDraft.trim();
    const next = trimmed || (isLocal ? t('librarySettings.localFallback') : libraryHostLabel(library.serverUrl));
    if (next !== nameDraft) setNameDraft(next);
    if (next !== library.name) updateLibrary(library.id, {name: next});
  };

  // Persist the URL to the stored list on blur. This no longer reconnects the
  // active library on its own — that's the explicit Reconnect button below — so a
  // stray edit-and-click-away never yanks the whole app into a reload.
  const commitUrl = () => {
    const trimmed = urlDraft.trim();
    if (trimmed === (library.serverUrl ?? '')) {
      setUrlError(null);
      return;
    }
    if (!isSafeServerUrl(trimmed)) {
      setUrlError(t('library.urlUnsafe'));
      return;
    }
    setUrlError(null);
    updateLibrary(library.id, {serverUrl: trimmed});
  };

  // An https page can't reach a plain http:// LAN server — the browser blocks it
  // as mixed content before CORS. Warn and guard rather than fail opaquely.
  const trimmedUrl = urlDraft.trim();
  const urlBlocked = isMixedContentBlocked(trimmedUrl);

  // Apply the (possibly edited) URL + token and re-point the live connection the
  // same way `selectLibrary` does: persist the record, set the overrides, reload.
  const reconnect = () => {
    if (!isSafeServerUrl(trimmedUrl)) {
      setUrlError(t('library.urlUnsafe'));
      return;
    }
    if (urlBlocked) return; // guarded; the warning explains why
    setUrlError(null);
    updateLibrary(library.id, {serverUrl: trimmedUrl});
    setServerTokenOverride(tokenDraft.trim() || null);
    setServerUrlOverride(trimmedUrl);
    if (typeof window !== 'undefined') window.location.reload();
  };

  const onRemove = async () => {
    if (!(await confirm({
      title: t('librarySettings.removeTitle', {name: library.name}),
      description: t('librarySettings.removeBody'),
      confirmText: t('common.remove'),
      destructive: true,
    }))) {
      return;
    }
    removeLibrary(library.id);
  };

  return (
    <div className={cn('flex flex-col gap-3 rounded-md border border-border p-3.5', active && 'border-brand/40')}>
      <div className="flex items-start gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`lib-icon-${library.id}`} className="text-xs text-muted-foreground">
            {t('library.icon')}
          </Label>
          <IconPicker
            id={`lib-icon-${library.id}`}
            value={library.icon}
            onPick={(icon) => updateLibrary(library.id, {icon})}
            fallback="📓"
            ariaLabel={t('library.icon')}
            className="flex h-9 w-11 items-center justify-center rounded-md border border-input bg-transparent text-lg transition-colors hover:bg-hover"
          />
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor={`lib-name-${library.id}`} className="text-xs text-muted-foreground">
            {t('library.name')}
          </Label>
          <Input
            id={`lib-name-${library.id}`}
            value={nameDraft}
            placeholder={t('library.namePlaceholder')}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => e.key === 'Enter' && commitName()}
          />
        </div>
        <div className="flex items-center gap-2 pt-6">
          <LibraryStatusDot serverUrl={library.serverUrl} active={active} />
          {active ? (
            <span className="rounded-full bg-brand/10 px-2 py-0.5 text-xs font-medium text-brand">
              {t('librarySettings.active')}
            </span>
          ) : (
            !isLocal && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                aria-label={t('library.removeLibrary', {name: library.name})}
                title={t('common.remove')}
                onClick={onRemove}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )
          )}
        </div>
      </div>

      <SettingsField label={t('library.serverUrl')} htmlFor={`lib-url-${library.id}`}>
        {isLocal ? (
          <p className="text-xs text-muted-foreground">{t('librarySettings.thisDeviceHint')}</p>
        ) : (
          <>
            <Input
              id={`lib-url-${library.id}`}
              value={urlDraft}
              placeholder={t('library.urlPlaceholder')}
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => {
                setUrlDraft(e.target.value);
                setUrlError(null);
              }}
              onBlur={commitUrl}
              onKeyDown={(e) => e.key === 'Enter' && (isConnection ? reconnect() : commitUrl())}
            />
            <p className="mt-1 text-xs text-muted-foreground">{libraryHostLabel(library.serverUrl)}</p>
            {urlError && <p className="mt-1 text-xs text-destructive">{urlError}</p>}
          </>
        )}
      </SettingsField>

      {/* Connection controls for the active remote library: the access token and
          an explicit Reconnect (SET2-1 folded the old Connection tab in here). */}
      {isConnection && (
        <>
          <SettingsField label={t('connection.accessToken')} htmlFor={`lib-token-${library.id}`}>
            <Input
              id={`lib-token-${library.id}`}
              type="password"
              value={tokenDraft}
              placeholder={t('connection.remoteTokenPlaceholder')}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setTokenDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && reconnect()}
            />
            <p className="mt-1 text-xs text-muted-foreground">{t('connection.remoteTokenHint')}</p>
          </SettingsField>
          {urlBlocked && (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
              {t('connection.mixedContentWarning')}
            </p>
          )}
          <div>
            <Button variant="outline" size="sm" onClick={reconnect} disabled={!trimmedUrl || urlBlocked}>
              {t('librarySettings.reconnect')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/** Inline "add a library" row: name + URL, validated before it's added. */
function AddLibraryRow() {
  const {t} = useTranslation();
  const {addLibrary} = useLibrary();
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('');
  const [url, setUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setError(t('library.urlRequired'));
      return;
    }
    if (!isSafeServerUrl(trimmed)) {
      setError(t('library.urlUnsafe'));
      return;
    }
    addLibrary({name, serverUrl: trimmed, icon});
    setName('');
    setIcon('');
    setUrl('');
    setError(null);
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-dashed border-border p-3.5">
      <div className="flex items-start gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lib-add-icon" className="text-xs text-muted-foreground">
            {t('library.icon')}
          </Label>
          <IconPicker
            id="lib-add-icon"
            value={icon}
            onPick={setIcon}
            fallback="📓"
            ariaLabel={t('library.icon')}
            className="flex h-9 w-11 items-center justify-center rounded-md border border-input bg-transparent text-lg transition-colors hover:bg-hover"
          />
        </div>
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="lib-add-name" className="text-xs text-muted-foreground">
            {t('library.name')}
          </Label>
          <Input
            id="lib-add-name"
            value={name}
            placeholder={t('library.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </div>
      <SettingsField label={t('library.serverUrl')} htmlFor="lib-add-url">
        <Input
          id="lib-add-url"
          value={url}
          placeholder={t('library.urlPlaceholder')}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => {
            setUrl(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </SettingsField>
      <div>
        <Button onClick={submit} disabled={!url.trim()}>
          <PlusIcon className="mr-2 h-4 w-4" />
          {t('library.addButton')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Manage every library (server connection) this device knows about: rename, change
 * icon, re-point the server URL, remove, and add new ones — the settings-side
 * counterpart to the library switcher. The local library is guarded (this device).
 */
export default function LibrarySettings() {
  const {t} = useTranslation();
  const {libraries, library} = useLibrary();

  return (
    <SettingsScreen title={t('librarySettings.title')} description={t('librarySettings.description')} scope="device">
      <SettingsSection title={t('librarySettings.yourLibraries')}>
        <div className="flex flex-col gap-3">
          {libraries.map((lib) => (
            <LibraryRow key={lib.id} library={lib} active={lib.id === library.id} />
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t('librarySettings.addTitle')}>
        <AddLibraryRow />
      </SettingsSection>
    </SettingsScreen>
  );
}
