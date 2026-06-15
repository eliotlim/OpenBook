import React from 'react';
import {dependencyGraph, type DatabaseProperty, type DatabaseView as DbView} from '@open-book/sdk';
import {readPageIcon} from '@/lib/pageIcon';
import type {UseDatabase} from './useDatabase';

const COL_W = 210;
const NODE_W = 168;
const NODE_H = 46;
const ROW_GAP = 66;
const PAD = 24;

const Hint: React.FC<{children: React.ReactNode}> = ({children}) => (
  <div className="rounded-md border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">{children}</div>
);

/**
 * Dependency graph view: rows as nodes in a left-to-right DAG, laid out by the
 * pure {@link dependencyGraph} layering (every node sits to the right of all its
 * predecessors). Edges are arrows predecessor → dependent; clicking a node opens
 * the row. Best paired with a `dependency` property (the view's
 * `dependencyPropertyId`).
 */
export const GraphView: React.FC<{db: UseDatabase; view: DbView; properties: DatabaseProperty[]}> = ({db, view, properties}) => {
  const depProp = view.dependencyPropertyId ? properties.find((p) => p.id === view.dependencyPropertyId) : undefined;
  if (!depProp) {
    return <Hint>Add a dependency property and select it in the view options to graph how rows connect.</Hint>;
  }
  if (db.visibleRows.length === 0) {
    return <Hint>No rows yet.</Hint>;
  }

  const graph = dependencyGraph(db.visibleRows, depProp.id);
  const rowById = new Map(db.visibleRows.map((r) => [r.id, r]));
  const pos = new Map(graph.nodes.map((n) => [n.id, {x: PAD + n.layer * COL_W, y: PAD + n.order * ROW_GAP}]));

  const width = PAD * 2 + graph.layerCount * COL_W - (COL_W - NODE_W);
  const height = PAD * 2 + graph.maxLayerSize * ROW_GAP - (ROW_GAP - NODE_H);

  const depCountOf = (id: string): number => {
    const raw = rowById.get(id)?.properties[depProp.id];
    return Array.isArray(raw) ? (raw as unknown[]).length : 0;
  };

  return (
    <div className="overflow-auto rounded-md border border-border bg-muted/10" style={{maxHeight: 560}}>
      <div className="relative" style={{width, height}}>
        <svg className="pointer-events-none absolute inset-0" width={width} height={height}>
          <defs>
            <marker id="ob-graph-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" className="fill-muted-foreground/70" />
            </marker>
          </defs>
          {graph.edges.map((e, i) => {
            const from = pos.get(e.from);
            const to = pos.get(e.to);
            if (!from || !to) return null;
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_H / 2;
            const dx = Math.max(28, (x2 - x1) / 2);
            return (
              <path
                key={i}
                d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2 - 2} ${y2}`}
                className="stroke-muted-foreground/55"
                strokeWidth={1.5}
                fill="none"
                markerEnd="url(#ob-graph-arrow)"
              />
            );
          })}
        </svg>

        {graph.nodes.map((n) => {
          const row = rowById.get(n.id);
          const p = pos.get(n.id)!;
          const count = depCountOf(n.id);
          return (
            <button
              key={n.id}
              onClick={() => db.openRow(n.id)}
              className="absolute flex flex-col justify-center gap-0.5 rounded-md border border-border bg-card px-2.5 text-left shadow-sm transition-colors hover:border-foreground/30 hover:bg-hover"
              style={{left: p.x, top: p.y, width: NODE_W, height: NODE_H}}
              title={row?.name?.trim() || 'Untitled'}
            >
              <span className="flex items-center gap-1.5">
                <span className="shrink-0 text-sm leading-none">{readPageIcon(n.id)}</span>
                <span className="truncate text-sm font-medium">{row?.name?.trim() || 'Untitled'}</span>
              </span>
              {count > 0 && (
                <span className="truncate text-[10px] text-muted-foreground">
                  depends on {count} {count === 1 ? 'row' : 'rows'}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default GraphView;
