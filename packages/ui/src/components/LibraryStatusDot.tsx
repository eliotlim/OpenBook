import {useTranslation} from '@/providers';
import {useLibraryStatus, type LibraryStatus} from '@/lib/libraryReachability';
import {cn} from '@/lib/utils';

const DOT_CLASS: Record<LibraryStatus, string> = {
  connected: 'bg-emerald-500',
  reachable: 'bg-emerald-500',
  unreachable: 'bg-amber-500',
  checking: 'bg-muted-foreground/50 animate-pulse',
  unknown: 'bg-muted-foreground/40',
};

const STATUS_LABEL: Record<LibraryStatus, `library.status.${LibraryStatus}`> = {
  connected: 'library.status.connected',
  reachable: 'library.status.reachable',
  unreachable: 'library.status.unreachable',
  checking: 'library.status.checking',
  unknown: 'library.status.unknown',
};

/**
 * A subtle connection-status dot for one library. Probes reachability itself
 * (see {@link useLibraryStatus}) — never blocks its parent — and titles itself
 * with the human status for hover/screen readers.
 */
export function LibraryStatusDot({serverUrl, active, className}: {serverUrl: string | null; active: boolean; className?: string}) {
  const {t} = useTranslation();
  const status = useLibraryStatus(serverUrl, active);
  const label = t(STATUS_LABEL[status]);
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('h-2 w-2 shrink-0 rounded-full', DOT_CLASS[status], className)}
    />
  );
}
