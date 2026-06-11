import {useEffect, useRef} from 'react';
import {useData} from '@/data';
import {setAiBridge} from '@/lib/aiBridge';

/**
 * Installs the AI bridge (lib/aiBridge) for the provider-less block editor
 * and keeps a lazily-refreshed readiness flag. Renders nothing. The poll is
 * deliberately gentle: once on mount, then only re-checked when an AI action
 * actually runs and fails.
 */
export function AiBridgeHost() {
  const client = useData();
  const readyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const probe = async (): Promise<void> => {
      try {
        const status = await client.aiStatus();
        if (!cancelled) readyRef.current = status.ready;
      } catch {
        if (!cancelled) readyRef.current = false;
      }
    };
    void probe();
    // Settings changes flow through the same client; re-probe when the tab
    // regains focus (cheap, no timers while idle).
    const onFocus = (): void => void probe();
    window.addEventListener('focus', onFocus);

    setAiBridge({
      ready: () => readyRef.current,
      complete: (text, onToken) => client.aiComplete(text, onToken),
      tasks: async (goal, context) => (await client.aiTasks(goal, context)).tasks,
    });
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      setAiBridge(null);
    };
  }, [client]);

  return null;
}

export default AiBridgeHost;
