import {createContext, useContext, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent} from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {Network} from 'lucide-react';
import type {PageGraph, PageGraphNode} from '@book.dev/sdk';
import {layeredLayout, type DataflowGraph} from '@/blockeditor/kit/dataflow';
import {getGraphTarget, subscribeGraphPane} from '@/lib/graphPane';
import {useData} from '@/data';
import {useNavigation, useTheme, useTranslation} from '@/providers';
import {PageIcon} from '@/components/PageIcon';
import {cn} from '@/lib/utils';

/**
 * The Page-graph side pane (OB-33): the whole-library link graph as a React Flow
 * node graph, centred on the current page. Nodes are readable pages (the server
 * threads the per-principal read gate, so a restricted page never reaches us);
 * edges are `@`-mentions (solid) and relation references (dashed), drawn
 * distinctly. The centred page is highlighted; clicking any node navigates the
 * primary pane to it.
 *
 * Cap (declared, never silent): we render the centred page's N-HOP neighbourhood
 * ({@link MAX_HOPS}) and, if that still exceeds {@link MAX_NODES}, the closest
 * nodes by BFS order — surfacing a "showing X of Y" note. With no centred page
 * (opened from Home) the whole graph is shown, capped by highest degree.
 */

/** How many hops out from the centred page to include. */
const MAX_HOPS = 2;
/** Hard ceiling on rendered nodes — keeps a huge library legible + snappy. */
const MAX_NODES = 140;

type GraphFlowNode = Node<{node: PageGraphNode; isCurrent: boolean}, 'page'>;

/**
 * Hover spotlight shared via context so node OBJECTS stay stable across a hover
 * (rebuilding the nodes array on hover makes react-flow swallow the click — the
 * same lesson DataflowView records).
 */
const HoverContext = createContext<{
  hovered: string | null;
  connected: ReadonlySet<string>;
  setHovered: (id: string | null) => void;
    }>({hovered: null, connected: new Set(), setHovered: () => undefined});

function PageNode({id, data}: NodeProps<GraphFlowNode>) {
  const {node, isCurrent} = data;
  const {hovered, connected, setHovered} = useContext(HoverContext);
  const dimmed = hovered !== null && !connected.has(id);
  return (
    <div
      data-graph-node={isCurrent ? 'current' : 'page'}
      onMouseEnter={() => setHovered(id)}
      onMouseLeave={() => setHovered(null)}
      className={cn(
        'flex w-48 items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-sm transition-opacity duration-150',
        isCurrent ? 'border-primary ring-2 ring-primary/30' : 'border-border',
        dimmed && 'opacity-30',
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-border !bg-muted-foreground/40" />
      <PageIcon value={node.icon ?? null} className="shrink-0 leading-none" />
      <span className={cn('min-w-0 truncate text-xs', isCurrent ? 'font-semibold' : 'font-medium')}>
        {node.name?.trim() || 'Untitled'}
      </span>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-border !bg-muted-foreground/40" />
    </div>
  );
}

const nodeTypes = {page: PageNode};

const EMPTY: PageGraph = {nodes: [], edges: []};

/** Fetch the whole-library graph, kept live off the page-list subscription. */
function usePageGraph(revision: number): {graph: PageGraph; loading: boolean} {
  const client = useData();
  const [graph, setGraph] = useState<PageGraph>(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    const refresh = (): void => {
      setLoading(true);
      void client
        .pageGraph()
        .then((g) => {
          if (live) setGraph(g);
        })
        .catch(() => {
          if (live) setGraph(EMPTY);
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    };
    refresh();
    const unsub = client.subscribePages(() => refresh());
    return () => {
      live = false;
      unsub();
    };
  }, [client, revision]);

  return {graph, loading};
}

/**
 * The centred page's N-hop neighbourhood (undirected), capped at {@link
 * MAX_NODES} closest-first. With no centre, the highest-degree slice of the whole
 * graph. Returns the kept sub-graph plus the total node count so the pane can
 * report "showing X of Y".
 */
function neighbourhood(graph: PageGraph, centre: string | null): {sub: PageGraph; total: number} {
  const total = graph.nodes.length;
  if (total === 0) return {sub: EMPTY, total};

  // Adjacency (undirected) for BFS + degree.
  const adj = new Map<string, Set<string>>();
  const touch = (a: string, b: string): void => {
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
  };
  for (const e of graph.edges) {
    touch(e.from, e.to);
    touch(e.to, e.from);
  }

  let keep: Set<string>;
  if (centre && graph.nodes.some((n) => n.id === centre)) {
    // BFS out to MAX_HOPS, collecting in distance order so a truncation keeps the
    // nearest pages.
    const ordered: string[] = [centre];
    const seen = new Set<string>([centre]);
    let frontier = [centre];
    for (let hop = 0; hop < MAX_HOPS && frontier.length > 0; hop += 1) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const nb of adj.get(id) ?? []) {
          if (seen.has(nb)) continue;
          seen.add(nb);
          ordered.push(nb);
          next.push(nb);
        }
      }
      frontier = next;
    }
    keep = new Set(ordered.slice(0, MAX_NODES));
  } else {
    // No centre: keep the highest-degree nodes.
    const byDegree = [...graph.nodes].sort((a, b) => (adj.get(b.id)?.size ?? 0) - (adj.get(a.id)?.size ?? 0));
    keep = new Set(byDegree.slice(0, MAX_NODES).map((n) => n.id));
  }

  const sub: PageGraph = {
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
  };
  return {sub, total};
}

export function GraphPaneBody() {
  const {t} = useTranslation();
  const {colorScheme} = useTheme();
  const {selectPage, focusPane, closeSplit, pageLabel} = useNavigation();

  const [target, setTarget] = useState(getGraphTarget());
  useEffect(() => subscribeGraphPane(() => setTarget(getGraphTarget())), []);
  const centre = target.pageId;

  const {graph, loading} = usePageGraph(target.revision);
  const {sub, total} = useMemo(() => neighbourhood(graph, centre), [graph, centre]);
  const shown = sub.nodes.length;
  // The graph is about CONNECTIONS: an isolated page (or an empty library) has
  // nothing to draw, so it gets the empty state rather than a lone dot.
  const hasGraph = sub.edges.length > 0;

  // Hover spotlight — node objects depend on the sub-graph ALONE (see HoverContext).
  const [hovered, setHovered] = useState<string | null>(null);
  const hoverValue = useMemo(() => {
    const connected = new Set<string>();
    if (hovered) {
      connected.add(hovered);
      for (const e of sub.edges) {
        if (e.from === hovered || e.to === hovered) {
          connected.add(e.from);
          connected.add(e.to);
        }
      }
    }
    return {hovered, connected, setHovered};
  }, [sub, hovered]);

  const nodes = useMemo<GraphFlowNode[]>(() => {
    // Reuse the shared layered layout (dataflow.ts) over our own {nodes,edges}.
    const shaped = {
      nodes: sub.nodes.map((n) => ({id: n.id, kind: 'code' as const})),
      edges: sub.edges.map((e) => ({id: `${e.from}->${e.to}:${e.kind}`, from: e.from, to: e.to})),
    } as unknown as DataflowGraph;
    const positions = layeredLayout(shaped);
    return sub.nodes.map((n) => ({
      id: n.id,
      type: 'page',
      position: positions.get(n.id) ?? {x: 0, y: 0},
      data: {node: n, isCurrent: n.id === centre},
    }));
  }, [sub, centre]);

  const edges = useMemo<Edge[]>(() => {
    return sub.edges.map((e) => {
      const lit = hovered !== null && (e.from === hovered || e.to === hovered);
      const dim = hovered !== null && !lit;
      const relation = e.kind === 'relation';
      return {
        id: `${e.from}->${e.to}:${e.kind}`,
        source: e.from,
        target: e.to,
        // Relation edges are dashed + primary-tinted; mentions are solid + muted.
        animated: relation,
        style: {
          stroke: relation
            ? `hsl(var(--primary) / ${lit ? 0.85 : 0.55})`
            : `hsl(var(--muted-foreground) / ${lit ? 0.7 : 0.4})`,
          strokeWidth: lit ? 1.75 : 1.25,
          strokeDasharray: relation ? '5 4' : undefined,
          opacity: dim ? 0.15 : 1,
          transition: 'opacity 150ms, stroke 150ms',
        },
      } satisfies Edge;
    });
  }, [sub, hovered]);

  // Re-fit when the graph SHAPE changes — guarded on xyflow v12 measurement so
  // the fit isn't a no-op against unmeasured nodes (the DataflowView lesson).
  const [instance, setInstance] = useState<ReactFlowInstance<GraphFlowNode, Edge> | null>(null);
  const shape = nodes.map((n) => n.id).join('|');
  useEffect(() => {
    if (!instance || !shape) return;
    let timer: ReturnType<typeof setTimeout>;
    let tries = 0;
    const tick = (): void => {
      const measured = instance.getNodes().every((node) => (node.measured?.width ?? 0) > 0);
      if (measured || tries >= 20) {
        void instance.fitView({padding: 0.15, maxZoom: 1.1, duration: 250});
        return;
      }
      tries += 1;
      timer = setTimeout(tick, 100);
    };
    timer = setTimeout(tick, 50);
    return () => clearTimeout(timer);
  }, [instance, shape]);

  const onNodeClick = (id: string): void => {
    focusPane('primary');
    selectPage(id);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeSplit();
    }
  };

  return (
    <div className="flex h-full flex-col" onKeyDown={onKeyDown} data-graph-view>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{t('graph.title')}</p>
          <p className="truncate text-xs text-muted-foreground">
            {centre ? pageLabel(centre) : t('graph.wholeLibrary')}
          </p>
        </div>
        {/* Legend: mention vs relation. */}
        <div className="flex shrink-0 items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <svg width="18" height="6" aria-hidden>
              <line x1="0" y1="3" x2="18" y2="3" stroke="hsl(var(--muted-foreground) / 0.6)" strokeWidth="1.5" />
            </svg>
            {t('graph.mention')}
          </span>
          <span className="flex items-center gap-1">
            <svg width="18" height="6" aria-hidden>
              <line
                x1="0"
                y1="3"
                x2="18"
                y2="3"
                stroke="hsl(var(--primary) / 0.7)"
                strokeWidth="1.5"
                strokeDasharray="5 4"
              />
            </svg>
            {t('graph.relation')}
          </span>
        </div>
      </div>

      {hasGraph && shown < total && (
        <p className="shrink-0 bg-muted/40 px-4 py-1 text-[11px] text-muted-foreground" data-graph-cap>
          {t('graph.showingXofY', {shown: String(shown), total: String(total)})}
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        {!hasGraph ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center" data-graph-empty>
            <Network className="h-6 w-6 text-muted-foreground/50" aria-hidden />
            <p className="text-sm text-muted-foreground">{loading ? t('graph.loading') : t('graph.empty')}</p>
            {!loading && <p className="max-w-xs text-xs text-muted-foreground/70">{t('graph.emptyHint')}</p>}
          </div>
        ) : (
          <HoverContext.Provider value={hoverValue}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              colorMode={colorScheme === 'dark' ? 'dark' : 'light'}
              fitView
              fitViewOptions={{padding: 0.15, maxZoom: 1.1}}
              onInit={setInstance}
              minZoom={0.2}
              nodesConnectable={false}
              nodesDraggable
              deleteKeyCode={null}
              onNodeClick={(_, node) => onNodeClick(node.id)}
              proOptions={{hideAttribution: false}}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </HoverContext.Provider>
        )}
      </div>
    </div>
  );
}

export default GraphPaneBody;
