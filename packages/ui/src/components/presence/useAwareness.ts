import {useEffect, useState} from 'react';
import type {Awareness} from 'y-protocols/awareness';
import {openAwareness, subscribeOpenAwareness} from '@/lib/openAwareness';

/**
 * Subscribe to a page's live presence (Collab T5). Tracks the registered
 * {@link Awareness} instance (it appears/disappears as the page mounts/unmounts —
 * `subscribeOpenAwareness`) and bumps `tick` on every presence `'change'`, so a
 * consumer re-renders when a peer joins, leaves, or moves their caret. The shared
 * read seam for both the avatar stack and the remote-cursor overlay — neither owns
 * the awareness, they just observe it.
 */
export function useAwareness(pageId: string | null | undefined): {
  awareness: Awareness | undefined;
  tick: number;
} {
  const [awareness, setAwareness] = useState<Awareness | undefined>(() => openAwareness(pageId));
  const [tick, setTick] = useState(0);

  // Follow the registry: re-read when an awareness is (un)registered for this page.
  useEffect(() => {
    const update = (): void => setAwareness(openAwareness(pageId));
    update();
    return subscribeOpenAwareness(update);
  }, [pageId]);

  // Re-render on every presence change (join / leave / caret move).
  useEffect(() => {
    if (!awareness) return;
    const onChange = (): void => setTick((t) => (t + 1) % Number.MAX_SAFE_INTEGER);
    awareness.on('change', onChange);
    return () => awareness.off('change', onChange);
  }, [awareness]);

  return {awareness, tick};
}
