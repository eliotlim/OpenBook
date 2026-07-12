import {useState} from 'react';
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
import {ChevronUpDownIcon, PlusIcon} from '@heroicons/react/24/outline';
import {CheckIcon, GlobeIcon} from '@radix-ui/react-icons';
import {Trash2} from 'lucide-react';
import {usePlatformCapabilities, useTranslation, useLibrary, libraryHostLabel} from '@/providers';

/**
 * The library switcher. `variant` controls the trigger only:
 *  - `sidebar` (default) — the full-width, two-line button at the top of the
 *    sidebar (web);
 *  - `titlebar` — a compact icon + name button for the desktop titlebar.
 * The dropdown contents (library list + "add a library") are identical.
 */
export default function LibrarySelectMenu({variant = 'sidebar'}: {variant?: 'sidebar' | 'titlebar'}) {
  const {libraries, library, selectLibrary, addLibrary, removeLibrary} = useLibrary();
  const {t} = useTranslation();
  // On a forwarded `<prefix>.book.cloud` site the app talks to the owner's
  // instance same-origin, so the local/default library (no server override)
  // has no host to name itself after — label it with the site host instead of
  // the generic "My Workspace".
  const {forwardedHost} = usePlatformCapabilities();
  const isForwardedLocal = (ws: {serverUrl: string | null}): boolean =>
    Boolean(forwardedHost) && ws.serverUrl === null;
  const nameFor = (ws: {serverUrl: string | null; name: string}): string =>
    isForwardedLocal(ws) ? forwardedHost! : ws.name;

  const [addOpen, setAddOpen] = useState(false);
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

  const submitAdd = () => {
    const url = serverUrl.trim();
    if (!url) {
      setError(t('library.urlRequired'));
      return;
    }
    try {
      // Validate the URL shape early so a typo doesn't silently fail on connect.
      new URL(url);
    } catch {
      setError(t('library.urlInvalid'));
      return;
    }
    addLibrary({name, serverUrl: url, icon});
    closeAdd();
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {variant === 'titlebar' ? (
            <Button variant="ghost" className="flex h-7 max-w-[200px] items-center gap-1.5 px-2">
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
              />
              <ChevronUpDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel>{t('library.libraries')}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {libraries.map((ws) => {
            const active = ws.id === library.id;
            const canRemove = !active && libraries.length > 1;
            return (
              <DropdownMenuItem
                key={ws.id}
                onSelect={() => selectLibrary(ws.id)}
                className="group flex items-center gap-2"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center text-lg leading-none">
                  {ws.icon}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{nameFor(ws)}</span>
                  {!isForwardedLocal(ws) && (
                    <span className="truncate text-xs text-muted-foreground">
                      {libraryHostLabel(ws.serverUrl)}
                    </span>
                  )}
                </span>
                {active && <CheckIcon className="h-4 w-4 shrink-0 text-brand" />}
                {canRemove && (
                  <button
                    type="button"
                    aria-label={t('library.removeLibrary', {name: ws.name})}
                    title={t('common.remove')}
                    className="hidden h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-hover hover:text-destructive group-hover:flex"
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
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={(e) => {
              e.preventDefault();
              resetForm();
              setAddOpen(true);
            }}
          >
            <PlusIcon className="mr-2 h-4 w-4" />
            {t('library.addLibrary')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={addOpen} onOpenChange={(open) => (open ? setAddOpen(true) : closeAdd())}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle>{t('library.addTitle')}</DialogTitle>
            <DialogDescription>{t('library.addDescription')}</DialogDescription>
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
                  className="flex h-9 items-center justify-center rounded-md border border-input bg-transparent text-lg transition-colors hover:bg-hover"
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
                onChange={(e) => {
                  setServerUrl(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && submitAdd()}
              />
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeAdd}>
              {t('common.cancel')}
            </Button>
            <Button onClick={submitAdd}>{t('library.addButton')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
