/**
 * LX-5 — preserved static block renders.
 *
 * An exported HTML file renders every block statically first (that is the no-JS,
 * print and PDF view), then hydrates the vendored viewer over it. For blocks the
 * viewer has no renderer for, hydration used to be a strict DOWNGRADE: a ledger
 * trial balance the exporter had computed into a real table (LX-3) was replaced
 * by a "requires the Ledger plugin" card, so double-clicking the file — the
 * common case — made the numbers disappear.
 *
 * The fix keeps the render that already exists. The export's boot script
 * harvests the marked static nodes out of the document body before it swaps in
 * the viewer host and passes them to `mount` keyed by block id; the viewer puts
 * them in this context, and {@link BlockBody} replants the node instead of
 * drawing its missing-plugin card.
 *
 * Deliberately content-agnostic: this module knows nothing about ledgers,
 * tables or plugins — only "the host document had a render for this block id".
 * That is what keeps the ledger's folds, wording and markers on the export side
 * and out of the viewer bundle (which gains this context and nothing else).
 *
 * The nodes are DOM elements, not HTML strings: they come from the boot as live
 * clones of nodes the browser already parsed, so replanting them re-parses
 * nothing and needs no `dangerouslySetInnerHTML`.
 */
import React, {createContext, useCallback, useContext} from 'react';

/** Static block renders the host document supplied, by block id. */
export type StaticKeepNodes = Readonly<Record<string, Element>>;

/** Provided by the viewer shell; `null` everywhere else (the app has the real
 *  plugin renderers, so it must never prefer a frozen snapshot over them). */
export const StaticKeepContext = createContext<StaticKeepNodes | null>(null);

/** The static render the host document carried for this block, if any. */
export function useStaticKeep(blockId: string): Element | null {
  const nodes = useContext(StaticKeepContext);
  if (!nodes || !blockId) return null;
  const node = nodes[blockId];
  return node instanceof Element ? node : null;
}

/**
 * Replant a preserved static node. React owns the wrapper and never looks
 * inside it, so the adopted subtree is left exactly as the export wrote it —
 * styled by the export document's own stylesheet, which hydration leaves in
 * place (only `<main>` is swapped).
 */
export const StaticKeepBlock: React.FC<{node: Element}> = ({node}) => {
  const attach = useCallback(
    (host: HTMLDivElement | null): void => {
      // Re-entrant-safe: a re-attach after a remount must not stack duplicates.
      if (host && node.parentNode !== host) {
        host.textContent = '';
        host.appendChild(node);
      }
    },
    [node],
  );
  return <div className="obe-static-keep" contentEditable={false} ref={attach} />;
};
