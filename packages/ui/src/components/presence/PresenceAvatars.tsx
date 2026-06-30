import type {AwarenessState} from '@/blockeditor';
import {Tooltip, TooltipContent, TooltipProvider, TooltipTrigger} from '@/components/ui/tooltip';
import {initialsOf} from '@/components/ProfileAvatar';
import {presencePeers, readableTextColor} from '@/lib/presence';
import {useAwareness} from './useAwareness';

/**
 * The "who's here" stack (Collab T5): a small, overlapping row of initial-avatars
 * — one per other person live on the page — tinted with each peer's presence
 * colour, with their name on a tooltip. Renders nothing when you're alone, so it
 * stays out of the way until collaboration is actually happening. The local user is
 * excluded (you already know you're here); multiple tabs of one person collapse to
 * a single avatar (deduped in {@link presencePeers}).
 */

/** How many faces to show before collapsing the rest into a "+N" chip. */
const MAX_AVATARS = 4;

export function PresenceAvatars({pageId}: {pageId: string}) {
  const {awareness} = useAwareness(pageId);
  const peers = awareness
    ? presencePeers(awareness.getStates() as Map<number, AwarenessState>, awareness.clientID)
    : [];
  if (peers.length === 0) return null;

  const shown = peers.slice(0, MAX_AVATARS);
  const overflow = peers.length - shown.length;

  return (
    <TooltipProvider delayDuration={150}>
      <div
        className="flex shrink-0 items-center -space-x-1.5 print:hidden"
        aria-label={`${peers.length} other ${peers.length === 1 ? 'person' : 'people'} here`}
      >
        {shown.map((peer) => (
          <Tooltip key={peer.clientId}>
            <TooltipTrigger asChild>
              <span
                aria-label={peer.name}
                className="flex h-6 w-6 select-none items-center justify-center rounded-full text-[10px] font-semibold leading-none ring-2 ring-background"
                style={{backgroundColor: peer.color, color: readableTextColor(peer.color)}}
              >
                {initialsOf(peer.name)}
              </span>
            </TooltipTrigger>
            <TooltipContent>{peer.name}</TooltipContent>
          </Tooltip>
        ))}
        {overflow > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex h-6 w-6 select-none items-center justify-center rounded-full bg-muted text-[10px] font-semibold leading-none text-muted-foreground ring-2 ring-background">
                +{overflow}
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {peers
                .slice(MAX_AVATARS)
                .map((p) => p.name)
                .join(', ')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
}

export default PresenceAvatars;
