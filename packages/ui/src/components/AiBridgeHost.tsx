import {useEffect, useRef} from 'react';
import type * as Y from 'yjs';
import type {AgentProposal} from '@open-book/sdk';
import {useData} from '@/data';
import {getBlockEditorDoc, setAiBridge, type ProposalApplyResult} from '@/lib/aiBridge';
import {
  blockText,
  decodeSnapshot,
  encodeSnapshot,
  findBlock,
  makeBlock,
  rootBlocks,
  type BlockDocSnapshot,
} from '@/blockeditor/model';
import {findInput, setInputValue} from '@/blockeditor/kit/scope';

/**
 * Installs the AI bridge (lib/aiBridge) for the provider-less block editor
 * and keeps a lazily-refreshed readiness flag. Renders nothing. The poll is
 * deliberately gentle: once on mount, then only re-checked when an AI action
 * actually runs and fails.
 *
 * The bridge also owns the agent WRITE path: applying an approved proposal set.
 * A change is applied in ONE CRDT transaction against the live editor doc when
 * the target page has a mounted editor (undoable + broadcast, like a kit
 * click); otherwise it's applied through the data client and merged by any live
 * editor on its next server push.
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

    // ── Apply one proposal (CRDT-first, server fallback) ────────────────────────
    const applyOne = async (p: AgentProposal): Promise<void> => {
      const payload = p.payload;
      if (p.kind === 'set_db_cell') {
        // DB cells are manual page properties — never in the editor CRDT.
        await client.updateRow(String(payload.databaseId), String(payload.rowId), {
          properties: {[String(payload.propertyId)]: payload.value},
        });
        return;
      }

      const pageId = String(payload.pageId ?? p.pageId ?? '');
      if (!pageId) throw new Error('proposal has no target page');
      const liveDoc = getBlockEditorDoc(pageId);

      if (liveDoc) {
        applyToDoc(liveDoc, p);
        return;
      }
      // No live editor — mutate the stored snapshot and save (merged on reopen).
      await applyToStoredPage(pageId, p);
    };

    /** Mutate a live Y.Doc in one transaction (origin 'local' → undoable). */
    const applyToDoc = (doc: Y.Doc, p: AgentProposal): void => {
      doc.transact(() => {
        const payload = p.payload;
        if (p.kind === 'set_kit_value') {
          const block = findInput(doc, String(payload.name));
          if (block) setInputValue(block, payload.value);
        } else if (p.kind === 'update_block') {
          const found = findBlock(doc, String(payload.blockId));
          const text = found && blockText(found.block);
          if (text) {
            text.delete(0, text.length);
            text.insert(0, String(payload.text));
          }
        } else if (p.kind === 'append_blocks') {
          const list = rootBlocks(doc);
          const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
          for (const b of blocks as Array<{type?: string; text?: string; props?: Record<string, unknown>}>) {
            list.push([makeBlock({type: b.type ?? 'paragraph', text: b.text, props: b.props})]);
          }
        }
      }, 'local');
    };

    /** Fallback: fetch, mutate the snapshot's block doc, and save. */
    const applyToStoredPage = async (pageId: string, p: AgentProposal): Promise<void> => {
      const page = await client.getPage(pageId);
      if (!page) throw new Error('page not found');
      const blockdoc = page.data.blockdoc as BlockDocSnapshot | undefined;
      // Rebuild a Y.Doc from the stored snapshot, mutate it, re-encode. This
      // keeps the CRDT history coherent for the next reader rather than hand-
      // editing the JSON projection.
      const doc = decodeSnapshot(blockdoc);
      applyToDoc(doc, p);
      await client.savePage({
        id: page.id,
        name: page.name,
        data: {...page.data, editor: 'blocks', blockdoc: encodeSnapshot(doc)},
      });
    };

    const applyProposals = async (proposals: AgentProposal[]): Promise<ProposalApplyResult> => {
      const failed: Array<{id: string; error: string}> = [];
      let applied = 0;
      // Group same-doc CRDT writes? Each applyOne already wraps a single
      // transaction; one approval = a tight batch the user can undo step by step.
      for (const p of proposals) {
        try {
          await applyOne(p);
          applied += 1;
        } catch (err) {
          failed.push({id: p.id, error: err instanceof Error ? err.message : String(err)});
        }
      }
      return {applied, failed};
    };

    setAiBridge({
      ready: () => readyRef.current,
      complete: (text, onToken) => client.aiComplete(text, onToken),
      tasks: async (goal, context) => (await client.aiTasks(goal, context)).tasks,
      applyProposals,
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
