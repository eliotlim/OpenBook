import {ChevronLeftIcon, ChevronRightIcon} from '@radix-ui/react-icons';
import {useNavigation} from '@/providers';
import {cn} from '@/lib/utils';

export default function BackForwardCluster() {
  const {goBack, goForward, canGoBack, canGoForward} = useNavigation();

  const buttonClass =
    'flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:text-muted-foreground/35';

  return (
    <div className="flex items-center overflow-hidden rounded-md">
      <button
        type="button"
        onClick={goBack}
        disabled={!canGoBack}
        aria-label="Go back"
        title="Back"
        className={buttonClass}
      >
        <ChevronLeftIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={goForward}
        disabled={!canGoForward}
        aria-label="Go forward"
        title="Forward"
        className={cn(buttonClass, 'border-l border-border/60')}
      >
        <ChevronRightIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
