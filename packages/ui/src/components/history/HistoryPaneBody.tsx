import {useEffect, useState} from 'react';
import {getHistoryTarget, subscribeHistoryPane} from '@/lib/historyPane';
import {useNavigation, useTranslation} from '@/providers';

/**
 * The Version-history side-pane body (PVH-4 scaffold). Reads the target page
 * from the `historyPane` bridge (set by the "Version history" affordance),
 * mirroring how the Review pane reads `reviewPane`. Mounted by SplitPane for the
 * {@link HISTORY_PANE_ID} pseudo-pane. The version list + read-only preview
 * (PVH-5) and restore-with-confirm (PVH-7) fill this in.
 */
export function HistoryPaneBody() {
  const [target, setTarget] = useState(getHistoryTarget());
  useEffect(() => subscribeHistoryPane(() => setTarget(getHistoryTarget())), []);

  const pageId = target.pageId;
  const {pageLabel} = useNavigation();
  const {t} = useTranslation();

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-4 py-2.5">
        <p className="truncate text-sm font-semibold">{t('history.title')}</p>
        <p className="truncate text-xs text-muted-foreground">
          {pageId ? pageLabel(pageId) : t('history.noPage')}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!pageId && <p className="text-xs text-muted-foreground">{t('history.noPage')}</p>}
      </div>
    </div>
  );
}

export default HistoryPaneBody;
