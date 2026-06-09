import React, {useState} from 'react';
import {Database, Link2, Plus, Search} from 'lucide-react';
import {useNavigation} from '@/providers';
import {readPageIcon} from '@/lib/pageIcon';

/** Lists every page that hosts a database and links the block to the chosen one. */
const DatabasePicker: React.FC<{onPick: (pageId: string) => void; onBack: () => void}> = ({onPick, onBack}) => {
  const {pages, pageLabel} = useNavigation();
  const [query, setQuery] = useState('');

  const databases = pages.filter((p) => p.hostedDatabaseId);
  const q = query.trim().toLowerCase();
  const results = q ? databases.filter((p) => (p.name ?? '').toLowerCase().includes(q)) : databases;

  return (
    <div>
      <div className="mb-2 flex items-center gap-1 rounded border border-border px-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search databases…"
          className="w-full bg-transparent py-1.5 text-sm outline-hidden placeholder:text-muted-foreground/50"
        />
      </div>
      <div className="max-h-60 space-y-0.5 overflow-y-auto">
        {results.length === 0 && (
          <div className="px-1.5 py-3 text-center text-xs text-muted-foreground">
            {databases.length === 0 ? 'No databases yet — create one first.' : 'No matching databases.'}
          </div>
        )}
        {results.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onPick(p.id)}
            className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-sm transition-colors hover:bg-accent"
          >
            <span className="shrink-0 leading-none">{readPageIcon(p.id)}</span>
            <span className="truncate">{p.name?.trim() || pageLabel(p.id)}</span>
          </button>
        ))}
      </div>
      <button onClick={onBack} className="mt-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
        ← Back
      </button>
    </div>
  );
};

/**
 * The inline prompt a fresh database block shows until it has a database: create
 * a new one, or link an existing database (chosen via {@link DatabasePicker}).
 * Rendered via a portal inside the document providers, so it reads the live page
 * list and triggers the block's create/link actions.
 */
export const InlineDatabaseChooser: React.FC<{onCreate: () => void; onPick: (pageId: string) => void}> = ({
  onCreate,
  onPick,
}) => {
  const [linking, setLinking] = useState(false);

  return (
    <div className="my-1 rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <Database className="h-4 w-4" />
        {linking ? 'Link an existing database' : 'Add a database'}
      </div>
      {linking ? (
        <DatabasePicker onPick={onPick} onBack={() => setLinking(false)} />
      ) : (
        <div className="flex flex-col gap-1">
          <button
            onClick={onCreate}
            className="flex items-center gap-2 rounded px-1.5 py-1.5 text-left text-sm transition-colors hover:bg-accent"
          >
            <Plus className="h-4 w-4 text-muted-foreground" />
            New database
          </button>
          <button
            onClick={() => setLinking(true)}
            className="flex items-center gap-2 rounded px-1.5 py-1.5 text-left text-sm transition-colors hover:bg-accent"
          >
            <Link2 className="h-4 w-4 text-muted-foreground" />
            Link existing database
          </button>
        </div>
      )}
    </div>
  );
};

export default InlineDatabaseChooser;
