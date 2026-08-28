import {Info} from "lucide-react"

import {Tooltip, TooltipContent, TooltipTrigger} from "@/components/ui/tooltip"
import {useTranslation} from "@/providers"

export function InfoTip({text}: {text: string}) {
  const {t} = useTranslation()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label={t('common.moreInfo')} className="shrink-0 rounded-sm focus-visible:outline-hidden focus-visible:shadow-[var(--ring-control)]">
          <Info className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72 whitespace-pre-line">{text}</TooltipContent>
    </Tooltip>
  )
}
