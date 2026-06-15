import {useEffect, useRef, useState} from 'react';
import type {AiSearchResult} from '@open-book/sdk';
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@/components/ui/dialog';
import {useData} from '@/data';
import {useHud, useNavigation, useTranslation} from '@/providers';
import {readPageIcon} from '@/lib/pageIcon';
import {cn} from '@/lib/utils';

/**
 * AI note search: ranked, snippeted results over every page's content.
 * Lexical (BM25) always works — server-side — and upgrades to hybrid
 * semantic ranking when the configured engine can embed. Opened from the
 * command palette ("Search notes with AI") or the sidebar.
 */
export function AiSearchDialog() {
  const {hud, setHud} = useHud();
  const {t} = useTranslation();
  const client = useData();
  const {selectPage} = useNavigation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AiSearchResult[]>([]);
  const [mode, setMode] = useState<'lexical' | 'hybrid' | null>(null);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = hud.ai.open;
  const setOpen = (next: boolean) =>
    setHud((draft) => {
      draft.ai.open = next;
      return draft;
    });

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setMode(null);
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (debounce.current) clearTimeout(debounce.current);
    if (!query.trim()) {
      setResults([]);
      setMode(null);
      return;
    }
    debounce.current = setTimeout(() => {
      setSearching(true);
      void client
        .aiSearch(query, 8)
        .then((res) => {
          setResults(res.results);
          setMode(res.mode);
          setActive(0);
        })
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 200);
  }, [query, open, client]);

  const pick = (result: AiSearchResult | undefined): void => {
    if (!result) return;
    selectPage(result.pageId);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-baseline gap-2">
            {t('aiSearch.title')}
            {mode && (
              <span className="text-xs font-normal text-muted-foreground">
                {mode === 'hybrid' ? t('aiSearch.semantic') : t('aiSearch.lexical')}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(results[active]);
            }
          }}
          placeholder={t('aiSearch.placeholder')}
          aria-label={t('aiSearch.title')}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-hidden focus:border-ring"
        />
        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto" role="listbox" aria-label={t('aiSearch.title')}>
          {results.map((result, i) => (
            <button
              key={result.pageId}
              type="button"
              role="option"
              aria-selected={i === active}
              data-ai-result
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(result)}
              className={cn(
                'flex flex-col gap-0.5 rounded-md px-3 py-2 text-left',
                i === active ? 'bg-accent' : 'hover:bg-hover',
              )}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <span aria-hidden>{readPageIcon(result.pageId)}</span>
                <span className="truncate">{result.title}</span>
              </span>
              <span className="line-clamp-2 text-xs text-muted-foreground">{result.snippet}</span>
            </button>
          ))}
          {query.trim() && !searching && results.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('aiSearch.empty')}</p>
          )}
          {!query.trim() && <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('aiSearch.hint')}</p>}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default AiSearchDialog;
