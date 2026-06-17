import React from 'react';
import type {PageMeta, VerificationValue} from '@open-book/sdk';
import {
  OWNER_PROPERTY_ID,
  VERIFICATION_PROPERTY_ID,
  isVerified,
  makeVerification,
  verificationExpired,
} from '@open-book/sdk';
import {BadgeCheck, Link2, ShieldAlert, ShieldCheck} from 'lucide-react';
import {useData} from '@/data';
import type {TKey} from '@/i18n';
import {useNavigation, useTranslation} from '@/providers';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {PersonChip, useIdentity} from '@/components/database/databaseCells';
import {DatabaseRowProperties} from '@/components/database/DatabaseRowProperties';
import {hydratePageIcons, readPageIcon, subscribePageIcon} from '@/lib/pageIcon';
import {hydratePageAppearance} from '@/lib/pageAppearance';
import {cn} from '@/lib/utils';

export interface PagePropertiesState {
  /** The page's stored property values (owner, verification, …), kept live. */
  properties: Record<string, unknown>;
  /** The database this page is a row of, or `null` for a standalone page. */
  databaseId: string | null;
  /** Optimistically set a property and persist it. */
  setProperty: (id: string, value: unknown) => void;
  /** Resolved owner name (`''` when unset) and verification value. */
  owner: string;
  verification: VerificationValue | undefined;
}

/**
 * Load a page's stored properties and keep them live (e.g. edited from a
 * database column elsewhere). Shared by the cover-area header controls and the
 * database-row field panel, so both read and write the same values. Also
 * hydrates the per-page appearance store from the same fetch — theme / cover /
 * fonts live on `page.properties` now ({@link lib/pageAppearance}).
 */
export function usePageProperties(pageId: string): PagePropertiesState {
  const client = useData();
  const [properties, setProperties] = React.useState<Record<string, unknown>>({});
  const [databaseId, setDatabaseId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setDatabaseId(null);
    setProperties({});
    void client.getPage(pageId).then((p) => {
      if (cancelled || !p) return;
      setProperties(p.properties ?? {});
      setDatabaseId(p.databaseId ?? null);
      hydratePageAppearance(pageId, p.properties);
    });
    const unsub = client.subscribePage(pageId, {
      onPage: (p) => {
        setProperties(p.properties ?? {});
        hydratePageAppearance(pageId, p.properties);
      },
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [client, pageId]);

  const setProperty = React.useCallback(
    (id: string, value: unknown) => {
      setProperties((prev) => ({...prev, [id]: value})); // optimistic
      void client.setPageProperties(pageId, {[id]: value}).catch(() => undefined);
    },
    [client, pageId],
  );

  const owner = typeof properties[OWNER_PROPERTY_ID] === 'string' ? (properties[OWNER_PROPERTY_ID] as string) : '';
  const verification = properties[VERIFICATION_PROPERTY_ID] as VerificationValue | undefined;
  return {properties, databaseId, setProperty, owner, verification};
}

/**
 * The properties shown under a page's title. Owner, Verification, and Backlinks
 * have moved up into the cover-area header controls; this now renders only a
 * database row's editable column fields (when the page is a row), so a standalone
 * page keeps a clean title with no empty panel.
 */
export const PageProperties: React.FC<{pageId: string}> = ({pageId}) => {
  const {databaseId} = usePageProperties(pageId);
  if (!databaseId) return null;
  return (
    <div className="mb-2 flex flex-col gap-0.5 border-b border-border/50 pb-3 pt-1">
      <DatabaseRowProperties pageId={pageId} databaseId={databaseId} />
    </div>
  );
};

/** Owner editor: a person chip; click to type a name, pick yourself, or clear. */
export const OwnerEditor: React.FC<{owner: string; onChange: (value: string | null) => void}> = ({owner, onChange}) => {
  const {t} = useTranslation();
  const identity = useIdentity();
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState('');

  const commit = (value: string | null) => {
    onChange(value);
    setDraft('');
    setOpen(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1 rounded px-1.5 py-1 text-sm transition-colors hover:bg-hover">
          {owner ? <PersonChip name={owner} /> : <span className="text-muted-foreground/50">{t('properties.setOwner')}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <div className="px-1.5 py-1" onKeyDown={(e) => e.stopPropagation()}>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) commit(draft.trim());
            }}
            placeholder={t('properties.ownerPlaceholder')}
            className="w-full rounded bg-accent/40 px-1.5 py-1 text-sm outline-hidden"
          />
        </div>
        {identity && identity.toLowerCase() !== owner.toLowerCase() && (
          <DropdownMenuItem onClick={() => commit(identity)} className="gap-2">
            <PersonChip name={identity} />
            <span className="ml-auto text-xs text-muted-foreground">{t('properties.you')}</span>
          </DropdownMenuItem>
        )}
        {owner && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => commit(null)} className="text-muted-foreground">
              {t('properties.clear')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** Verification expiry presets (days from now, or `null` for no expiry). */
const EXPIRY_CHOICES: Array<{key: TKey; days: number | null}> = [
  {key: 'properties.verifyExpiry30', days: 30},
  {key: 'properties.verifyExpiry90', days: 90},
  {key: 'properties.verifyExpiry365', days: 365},
  {key: 'properties.verifyNoExpiry', days: null},
];
const DAY_MS = 86_400_000;
const expiryIso = (days: number | null): string | null => (days === null ? null : new Date(Date.now() + days * DAY_MS).toISOString());

/**
 * Verification editor: verify the page (stamping you + now, with a chosen
 * expiry) or, once verified, review / change the expiry or remove it. An expired
 * verification reads as lapsed (amber) rather than verified (green).
 */
export const VerificationEditor: React.FC<{value?: VerificationValue; onChange: (value: VerificationValue) => void}> = ({
  value,
  onChange,
}) => {
  const {t} = useTranslation();
  const identity = useIdentity();
  const verify = (days: number | null) => onChange(makeVerification(identity, new Date().toISOString(), expiryIso(days)));

  if (isVerified(value)) {
    const expired = verificationExpired(value);
    const by = value?.by;
    const at = value?.at;
    const expiresAt = value?.expiresAt;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium transition-colors',
              expired
                ? 'bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300'
                : 'bg-green-500/10 text-green-700 hover:bg-green-500/20 dark:text-green-300',
            )}
          >
            {expired ? (
              <ShieldAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            ) : (
              <BadgeCheck className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
            )}
            {expired ? t('properties.verifyExpired') : t('properties.verified')}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {by ? t('properties.verifiedBy', {name: by}) : t('properties.verified')}
            {at ? ` · ${new Date(at).toLocaleDateString()}` : ''}
            {expiresAt && (
              <div className={expired ? 'text-amber-600 dark:text-amber-400' : ''}>
                {expired
                  ? t('properties.verifyExpiredOn', {date: new Date(expiresAt).toLocaleDateString()})
                  : t('properties.verifyExpiresOn', {date: new Date(expiresAt).toLocaleDateString()})}
              </div>
            )}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
            {t('properties.verifyReverify')}
          </DropdownMenuLabel>
          {EXPIRY_CHOICES.map((c) => (
            <DropdownMenuItem key={c.key} onClick={() => verify(c.days)}>
              {t(c.key)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onChange({verified: false})} className="text-destructive focus:text-destructive">
            {t('properties.unverify')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          <ShieldCheck className="h-3.5 w-3.5" />
          {t('properties.verify')}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
          {t('properties.verifyExpiryPrompt')}
        </DropdownMenuLabel>
        {EXPIRY_CHOICES.map((c) => (
          <DropdownMenuItem key={c.key} onClick={() => verify(c.days)}>
            {t(c.key)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/** Fetch a page's backlinks and keep them fresh as the page set changes. */
function usePageBacklinks(pageId: string): PageMeta[] {
  const client = useData();
  const [links, setLinks] = React.useState<PageMeta[]>([]);
  const refresh = React.useCallback(() => {
    void client
      .listBacklinks(pageId)
      .then((l) => {
        setLinks(l);
        hydratePageIcons(l); // backlinks can be DB rows that aren't in the sidebar
      })
      .catch(() => undefined);
  }, [client, pageId]);
  React.useEffect(() => {
    refresh();
    return client.subscribePages(() => refresh());
  }, [client, refresh]);
  return links;
}

/**
 * Backlinks, collapsed: a compact "N backlinks" chip in the header controls that
 * opens the list on click (hidden weight by default — the links are rarely the
 * point, but the count is a useful signal). Lives beside owner / verification.
 */
export const BacklinksControl: React.FC<{pageId: string}> = ({pageId}) => {
  const {t} = useTranslation();
  const {selectPage, pageLabel} = useNavigation();
  const links = usePageBacklinks(pageId);
  const [open, setOpen] = React.useState(false);
  // Backlink chips show each page's icon (localStorage) — re-render when one changes.
  const [, bumpIcon] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => subscribePageIcon(bumpIcon), []);

  const count = links.length;
  if (count === 0) {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-1 text-sm text-muted-foreground/40">
        <Link2 className="h-3.5 w-3.5" />
        {t('properties.noBacklinks')}
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
        >
          <Link2 className="h-3.5 w-3.5" />
          {count === 1 ? t('properties.backlinkCountOne') : t('properties.backlinkCount', {count})}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        <p className="px-1.5 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('properties.backlinks')}
        </p>
        <div className="flex max-h-72 flex-col overflow-y-auto">
          {links.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                selectPage(p.id);
                setOpen(false);
              }}
              className="flex items-center gap-1.5 rounded px-1.5 py-1 text-left text-sm transition-colors hover:bg-hover"
              title={p.name?.trim() || pageLabel(p.id)}
            >
              <span className="leading-none">{readPageIcon(p.id)}</span>
              <span className="truncate">{p.name?.trim() || pageLabel(p.id)}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
};

export default PageProperties;
