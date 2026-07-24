import {useEffect, useRef} from 'react';
import type {AgentProposal, StoredSuggestion} from '@book.dev/sdk';
import {useData} from '@/data';
import {applyProposal, setAiBridge, suggestionToProposal, type ProposalApplyResult} from '@/lib/aiBridge';

/**
 * Installs the AI bridge (lib/aiBridge) for the provider-less block editor
 * and keeps a lazily-refreshed readiness flag. Renders nothing. The poll is
 * deliberately gentle: once on mount, then only re-checked when an AI action
 * actually runs and fails.
 *
 * The bridge also owns the agent WRITE path: applying an approved proposal set.
 * The apply logic itself lives in {@link applyProposal} (lib/aiBridge) — a pure
 * function shared with the agent-edits policy router (AGED-4) — so this host
 * only wires it to the live data client. A change is applied in ONE CRDT
 * transaction against the live editor doc when the target page has a mounted
 * editor (undoable + broadcast, like a kit click); otherwise it's applied
 * through the data client and merged by any live editor on its next server push.
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
    const onFocus = (): void => void probe();
    window.addEventListener('focus', onFocus);

    const applyProposals = async (proposals: AgentProposal[]): Promise<ProposalApplyResult> => {
      const failed: Array<{id: string; error: string}> = [];
      let applied = 0;
      // Each applyProposal wraps a single CRDT transaction; one approval = a
      // tight batch the user can undo step by step.
      for (const p of proposals) {
        try {
          await applyProposal(client, p);
          applied += 1;
        } catch (err) {
          failed.push({id: p.id, error: err instanceof Error ? err.message : String(err)});
        }
      }
      return {applied, failed};
    };

    // Apply one accepted suggestion through the same CRDT-first path. AI and
    // human suggestions are identical here: the proposal shape is reconstructed
    // from the suggestion's payload (which carries the original write-tool kind).
    const applySuggestion = async (suggestion: StoredSuggestion): Promise<void> => {
      await applyProposal(client, suggestionToProposal(suggestion));
    };

    setAiBridge({
      ready: () => readyRef.current,
      complete: (text, onToken) => client.aiComplete(text, onToken),
      tasks: async (goal, context) => (await client.aiTasks(goal, context)).tasks,
      applyProposals,
      applySuggestion,
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
