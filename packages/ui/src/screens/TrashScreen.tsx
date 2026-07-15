import {useEffect} from 'react';
import {Trash2} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {useNavigation, useTranslation} from '@/providers';
import {useTrash} from '@/lib/useTrash';
import TrashList from '@/components/TrashList';

/**
 * The Trash view rendered for the `?page=trash` pseudo-page (DocumentArea routes
 * it here, the way it routes {@link HOME_PAGE_ID} to Home). A full-page peer of
 * the quick {@link TrashDialog} overlay — both share the list body + actions via
 * {@link useTrash} — so a copied `?page=trash` deep link, Back/Forward, and new
 * tabs all reach a proper page instead of a transient dialog.
 */
export default function TrashScreen() {
  const {t} = useTranslation();
  const {selectPage} = useNavigation();
  const trash = useTrash((pageId) => selectPage(pageId));
  const {items, busy, refresh, emptyTrash} = trash;

  // A pseudo-page has no document to load, so list on mount (and re-list when the
  // client swaps under a no-reload library switch).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="w-full px-6 pb-24 pt-16 md:px-10" data-trash-screen>
      <div className="mx-auto w-full max-w-content">
        <header className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2.5 text-3xl font-semibold tracking-tight">
              <Trash2 className="h-7 w-7 text-muted-foreground" />
              {t('nav.trash')}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('trash.description')}</p>
          </div>
          {items.length > 0 && (
            <Button variant="destructive" disabled={busy !== null} onClick={() => void emptyTrash()}>
              {t('trash.emptyTrash')}
            </Button>
          )}
        </header>

        <TrashList trash={trash} emptyLabel={t('trash.pageEmptyHint')} />
      </div>
    </div>
  );
}
