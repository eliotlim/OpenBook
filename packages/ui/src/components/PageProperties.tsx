import React from 'react';
import type {PageMeta, VerificationValue} from '@open-book/sdk';
import {
  OWNER_PROPERTY_ID,
  VERIFICATION_PROPERTY_ID,
  isVerified,
  makeVerification,
} from '@open-book/sdk';
import {BadgeCheck, Link2, RefreshCw, ShieldCheck} from 'lucide-react';
import {useData} from '@/data';
import {useNavigation, useTranslation} from '@/providers';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {IconButton} from '@/components/ui/icon-button';
import {PersonChip, useIdentity} from '@/components/database/databaseCells';
import {DatabaseRowProperties} from '@/components/database/DatabaseRowProperties';
import {readPageIcon, subscribePageIcon} from '@/lib/pageIcon';

/** One labelled property row in the panel. */
const PropRow: React.FC<{icon: React.ReactNode; label: string; children: React.ReactNode}> = ({icon, label, children}) => (
  <div className="flex min-h-[28px] items-start gap-2">
    <span className="flex w-28 shrink-0 select-none items-center gap-1.5 pt-1.5 text-sm text-muted-foreground">
      <span className="text-muted-foreground/60">{icon}</span>
      {label}
    </span>
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);

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
 * database column elsewhere). Shared by the properties panel below the title and
 * the header controls above it, so both read and write the same values.
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
    });
    const unsub = client.subscribePage(pageId, {onPage: (p) => setProperties(p.properties ?? {})});
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
 * The wiki-style **properties panel** shown under a page's title: database-row
 * fields (when the page is a row) and Backlinks. Owner and Verification have
 * moved up into the cover-area header controls, but still write the same
 * reserved property ids, so a page reads as an enhanced knowledge-base entry
 * standalone, and as a row when gathered into a database.
 */
export const PageProperties: React.FC<{pageId: string}> = ({pageId}) => {
  const client = useData();
  const {t} = useTranslation();
  const {databaseId} = usePageProperties(pageId);
  const [backlinks, setBacklinks] = React.useState<PageMeta[]>([]);
  // Page icons live in localStorage; re-render backlink chips when one changes.
  const [, bumpIcon] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => subscribePageIcon(bumpIcon), []);

  const refreshBacklinks = React.useCallback(() => {
    void client.listBacklinks(pageId).then(setBacklinks).catch(() => undefined);
  }, [client, pageId]);

  // Fetch backlinks, and refresh when the page set changes (a new/renamed page
  // may add a link to this one).
  React.useEffect(() => {
    refreshBacklinks();
    return client.subscribePages(() => refreshBacklinks());
  }, [client, refreshBacklinks]);

  return (
    <div className="mb-2 flex flex-col gap-0.5 border-b border-border/50 pb-3 pt-1">
      {/* Database rows surface their columns here as editable, groupable fields. */}
      {databaseId && <DatabaseRowProperties pageId={pageId} databaseId={databaseId} />}
      <PropRow icon={<Link2 className="h-3.5 w-3.5" />} label={t('properties.backlinks')}>
        <Backlinks links={backlinks} onRefresh={refreshBacklinks} />
      </PropRow>
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
        <button className="flex items-center gap-1 rounded px-1.5 py-1 text-sm transition-colors hover:bg-accent">
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

/** Verification editor: verify (stamping you + now) or remove verification. */
export const VerificationEditor: React.FC<{value?: VerificationValue; onChange: (value: VerificationValue) => void}> = ({
  value,
  onChange,
}) => {
  const {t} = useTranslation();
  const identity = useIdentity();

  if (isVerified(value)) {
    const by = value?.by;
    const at = value?.at;
    return (
      <div className="flex flex-wrap items-center gap-2 py-0.5">
        <span className="inline-flex items-center gap-1 rounded bg-green-500/10 px-1.5 py-0.5 text-xs font-medium text-green-700 dark:text-green-300">
          <BadgeCheck className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
          {t('properties.verified')}
        </span>
        {(by || at) && (
          <span className="text-xs text-muted-foreground">
            {by ? t('properties.verifiedBy', {name: by}) : ''}
            {at ? ` · ${new Date(at).toLocaleDateString()}` : ''}
          </span>
        )}
        <button
          type="button"
          onClick={() => onChange({verified: false})}
          className="text-xs text-muted-foreground transition-colors hover:text-destructive"
        >
          {t('properties.unverify')}
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onChange(makeVerification(identity, new Date().toISOString()))}
      className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <ShieldCheck className="h-3.5 w-3.5" />
      {t('properties.verify')}
    </button>
  );
};

/** Backlinks: chips for each page that links here, with a manual refresh. */
const Backlinks: React.FC<{links: PageMeta[]; onRefresh: () => void}> = ({links, onRefresh}) => {
  const {t} = useTranslation();
  const {selectPage, pageLabel} = useNavigation();

  if (links.length === 0) {
    return (
      <div className="flex items-center gap-1 px-1.5 py-1 text-sm text-muted-foreground/50">
        {t('properties.noBacklinks')}
        <IconButton size="sm" className="h-5 w-5 p-0.5" onClick={onRefresh} aria-label={t('properties.refresh')} title={t('properties.refresh')}>
          <RefreshCw className="h-3 w-3" />
        </IconButton>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1 py-1">
      {links.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => selectPage(p.id)}
          className="inline-flex max-w-full items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-xs transition-colors hover:bg-accent"
          title={p.name?.trim() || pageLabel(p.id)}
        >
          <span className="leading-none">{readPageIcon(p.id)}</span>
          <span className="max-w-[160px] truncate">{p.name?.trim() || pageLabel(p.id)}</span>
        </button>
      ))}
      <IconButton size="sm" className="h-5 w-5 p-0.5" onClick={onRefresh} aria-label={t('properties.refresh')} title={t('properties.refresh')}>
        <RefreshCw className="h-3 w-3" />
      </IconButton>
    </div>
  );
};

export default PageProperties;
