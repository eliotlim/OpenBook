import {ChevronLeftIcon, ChevronRightIcon} from '@radix-ui/react-icons';
import {useNavigation, useTranslation} from '@/providers';
import {cn} from '@/lib/utils';

export default function BackForwardCluster() {
  const {goBack, goForward, canGoBack, canGoForward} = useNavigation();
  const {t} = useTranslation();

  const buttonClass =
    'flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:text-muted-foreground/35';

  return (
    <div className="flex items-center overflow-hidden rounded-md">
      <button
        type="button"
        onClick={goBack}
        disabled={!canGoBack}
        aria-label={t('nav.goBack')}
        title={t('nav.back')}
        className={buttonClass}
      >
        <ChevronLeftIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={goForward}
        disabled={!canGoForward}
        aria-label={t('nav.goForward')}
        title={t('nav.forward')}
        className={cn(buttonClass, 'border-l border-border/60')}
      >
        <ChevronRightIcon className="h-4 w-4" />
      </button>
    </div>
  );
}
