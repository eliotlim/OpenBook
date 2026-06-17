import {useEffect, useRef} from 'react';
import type * as Y from 'yjs';
import type {AgentProposal, StoredSuggestion} from '@open-book/sdk';
import {useData} from '@/data';
import {getBlockEditorDoc, setAiBridge, suggestionToProposal, type ProposalApplyResult} from '@/lib/aiBridge';
import {
  blockText,
  coerceNewBlock,
  decodeSnapshot,
  encodeSnapshot,
  findBlock,
  makeBlock,
  replaceText,
  rootBlocks,
  type BlockDocSnapshot,
  type NewBlock,
} from '@/blockeditor/model';
import {findInput, setInputValue} from '@/blockeditor/kit/scope';
import {merge3} from '@/lib/textMerge';
import {readPageTheme, writePageTheme} from '@/lib/pageTheme';
import {COVER_GRADIENTS, writePageCover} from '@/lib/pageCover';
import type {AppearanceOverride} from '@/lib/themes';

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

      if (p.kind === 'set_page_theme') {
        // Appearance is a per-page viewing preference (localStorage), not CRDT
        // content — apply it directly here on the client.
        applyPageAppearance(pageId, payload);
        return;
      }

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
            const theirs = String(payload.text ?? '');
            // `payload.before` is the block text when the suggestion was made.
            // Merging against it (rather than replacing wholesale) means a second
            // suggestion accepted on the same block keeps the first one's edit
            // instead of clobbering it; with no base we fall back to a replace.
            const base = typeof payload.before === 'string' ? payload.before : null;
            const next = base === null ? theirs : merge3(base, text.toString(), theirs);
            replaceText(text, next);
          }
        } else if (p.kind === 'append_blocks') {
          const list = rootBlocks(doc);
          const raw = Array.isArray(payload.blocks) ? payload.blocks : [];
          const built = raw
            .map(coerceNewBlock)
            .filter((b): b is NewBlock => b !== null)
            .map(makeBlock);
          if (built.length > 0) list.push(built);
        }
      }, 'local');
    };

    /** Apply a per-page appearance proposal (theme + optional cover gradient). */
    const applyPageAppearance = (pageId: string, payload: Record<string, unknown>): void => {
      if (payload.theme && typeof payload.theme === 'object') {
        // Merge over any existing override so we only change the named knobs.
        writePageTheme(pageId, {...readPageTheme(pageId), ...(payload.theme as AppearanceOverride)});
      }
      if (typeof payload.coverGradientId === 'string' && payload.coverGradientId) {
        const gradient = COVER_GRADIENTS.find((c) => c.id === payload.coverGradientId);
        if (gradient) writePageCover(pageId, {kind: 'gradient', css: gradient.css});
      }
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

    // Apply one accepted suggestion through the same CRDT-first path. AI and
    // human suggestions are identical here: the proposal shape is reconstructed
    // from the suggestion's payload (which carries the original write-tool kind).
    const applySuggestion = async (suggestion: StoredSuggestion): Promise<void> => {
      await applyOne(suggestionToProposal(suggestion));
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
