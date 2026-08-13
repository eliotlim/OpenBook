import {EyeOff} from 'lucide-react';
import {useTranslation} from '@/providers';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '@/components/ui/tooltip';

/** Owner-only discovery marker shared by every sidebar page row. */
export function HiddenPageBadge() {
  const {t} = useTranslation();
  const label = t('nav.hiddenPage');
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            role="img"
            aria-label={label}
            data-hidden-page-badge
            className="ml-1 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/70 dark:text-muted-foreground/80"
          >
            <EyeOff aria-hidden className="h-3.5 w-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
