import React, {useContext, useEffect, useMemo, useState} from 'react';
import {isSafeHref, type DatabaseFormReference, type StoredDatabase} from '@book.dev/sdk';
import {FileText, Search} from 'lucide-react';
import {FormOriginContext} from '@/blockeditor/FormBlockView';
import {blockProp, setBlockProp, type NewBlock} from '@/blockeditor/model';
import {registerCustomBlock, type CustomBlockProps} from '@/blockeditor/registry';
import {useOptionalData} from '@/data';
import {pageLinks, type PageLinkResult} from '@/lib/pageLinks';
import {useTranslation} from '@/providers';
import {DatabaseForm} from './databaseForm';

/** The only block-specific state a database-form embed persists. */
export function databaseFormReferenceFromBlock(block: CustomBlockProps['block']): DatabaseFormReference | null {
  const databaseId = blockProp<string>(block, 'databaseId');
  const viewId = blockProp<string>(block, 'viewId');
  return databaseId && viewId ? {databaseId, viewId} : null;
}

export const makeDatabaseFormBlock = (): NewBlock => ({type: 'dbform'});

const DatabaseFormMissing: React.FC = () => {
  const {t} = useTranslation();
  return (
    <div
      className="rounded-lg border border-border bg-card px-4 py-5 text-center text-sm text-muted-foreground"
      data-database-form-block-missing
      role="status"
    >
      {t('formBlock.databaseReference.missing')}
    </div>
  );
};

const DatabaseFormStaticLink: React.FC<{reference: DatabaseFormReference}> = ({reference}) => {
  const {t} = useTranslation();
  const originUrl = useContext(FormOriginContext);
  const href = originUrl && isSafeHref(originUrl) ? originUrl : '#';
  return (
    <a
      className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-3 text-sm font-medium text-foreground hover:bg-hover"
      href={href}
      data-database-id={reference.databaseId}
      data-form-view-id={reference.viewId}
    >
      <FileText className="h-4 w-4" />
      {t('formBlock.databaseReference.openForm')}
    </a>
  );
};

const DatabaseFormPicker: React.FC<{onPick: (reference: DatabaseFormReference) => void}> = ({onPick}) => {
  const client = useOptionalData();
  const {t} = useTranslation();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<PageLinkResult | null>(null);
  const [database, setDatabase] = useState<StoredDatabase | null>(null);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const databases = useMemo(
    () => pageLinks.searchPages(query, {databasesOnly: true}),
    [query],
  );

  const chooseDatabase = (result: PageLinkResult): void => {
    if (!client) return;
    setSelected(result);
    setDatabase(null);
    setUnavailable(false);
    setLoading(true);
    void client.getPageDatabase(result.id)
      .then((next) => {
        setDatabase(next);
        setUnavailable(next === null);
      })
      .catch(() => setUnavailable(true))
      .finally(() => setLoading(false));
  };

  const goBack = (): void => {
    setSelected(null);
    setDatabase(null);
    setUnavailable(false);
  };
  const formViews = database?.schema.views.filter((view) => view.type === 'form') ?? [];

  return (
    <div className="my-1 rounded-lg border border-border bg-card p-3" data-database-form-picker>
      <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <FileText className="h-4 w-4" />
        {t(selected ? 'formBlock.databaseReference.chooseForm' : 'formBlock.databaseReference.chooseDatabase')}
      </div>
      {!selected ? (
        <>
          <div className="mb-2 flex items-center gap-1 rounded border border-border px-1.5">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('formBlock.databaseReference.searchDatabases')}
              aria-label={t('formBlock.databaseReference.searchDatabases')}
              className="w-full bg-transparent py-1.5 text-sm outline-hidden placeholder:text-placeholder-foreground"
            />
          </div>
          <div className="max-h-60 space-y-0.5 overflow-y-auto">
            {databases.map((result) => (
              <button
                key={result.id}
                type="button"
                onClick={() => chooseDatabase(result)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-sm transition-colors hover:bg-hover"
              >
                <span aria-hidden>{result.icon}</span>
                <span className="min-w-0 truncate">{result.label}</span>
                {result.path && <span className="ml-auto min-w-0 truncate pl-2 text-xs text-muted-foreground">{result.path}</span>}
              </button>
            ))}
            {databases.length === 0 && (
              <div className="px-1.5 py-3 text-center text-xs text-muted-foreground">
                {t('formBlock.databaseReference.noDatabases')}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="max-h-60 space-y-0.5 overflow-y-auto">
            {loading && <div className="px-1.5 py-3 text-center text-xs text-muted-foreground">{t('formBlock.databaseReference.loadingForms')}</div>}
            {!loading && unavailable && <div className="px-1.5 py-3 text-center text-xs text-muted-foreground">{t('formBlock.databaseReference.databaseUnavailable')}</div>}
            {!loading && !unavailable && formViews.map((view) => (
              <button
                key={view.id}
                type="button"
                onClick={() => onPick({databaseId: database!.id, viewId: view.id})}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-sm transition-colors hover:bg-hover"
              >
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{view.name}</span>
              </button>
            ))}
            {!loading && !unavailable && database && formViews.length === 0 && (
              <div className="px-1.5 py-3 text-center text-xs text-muted-foreground">
                {t('formBlock.databaseReference.noForms')}
              </div>
            )}
          </div>
          <button type="button" onClick={goBack} className="mt-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
            {t('formBlock.databaseReference.back')}
          </button>
        </>
      )}
    </div>
  );
};

export const DatabaseFormBlock: React.FC<CustomBlockProps> = ({block, editor, pageReadOnly}) => {
  const client = useOptionalData();
  const {t} = useTranslation();
  const reference = databaseFormReferenceFromBlock(block);
  const [database, setDatabase] = useState<StoredDatabase | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDatabase(null);
    if (!client || !reference) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void client.getDatabase(reference.databaseId)
      .then((next) => {
        if (!cancelled) setDatabase(next);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [client, reference?.databaseId, reference?.viewId]);

  if (!reference) {
    if (pageReadOnly) return <DatabaseFormMissing />;
    return (
      <DatabaseFormPicker
        onPick={(next) => editor.doc.transact(() => {
          setBlockProp(block, 'databaseId', next.databaseId);
          setBlockProp(block, 'viewId', next.viewId);
        }, 'local')}
      />
    );
  }
  if (!client) return <DatabaseFormStaticLink reference={reference} />;
  if (loading) {
    return <div className="rounded-lg border border-border bg-card px-4 py-5 text-center text-sm text-muted-foreground">{t('formBlock.databaseReference.loadingForm')}</div>;
  }
  const view = database?.schema.views.find((candidate) => candidate.id === reference.viewId);
  if (!database || view?.type !== 'form') return <DatabaseFormMissing />;

  return (
    <DatabaseForm
      key={`${reference.databaseId}:${reference.viewId}`}
      view={view}
      properties={database.schema.properties}
      canEdit={false}
      onUpdateView={async () => undefined}
      onCreateProperty={async () => undefined}
      onSubmit={async (fields) => (await client.createRow(reference.databaseId, {name: null, properties: fields})).id}
    />
  );
};

/** Register beside dbview; the legacy `form` registration remains independent. */
export function registerDatabaseFormBlock(): void {
  registerCustomBlock({
    type: 'dbform',
    render: DatabaseFormBlock,
    slash: {
      label: 'Form — database',
      hint: 'Embed an existing database form',
      keywords: 'form database survey response embed existing view',
      group: 'interactive',
      make: makeDatabaseFormBlock,
    },
  });
}
