import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
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
import {Columns2, FolderOpen, Link2, Network} from 'lucide-react';
import type {PageGraph, PageGraphNode} from '@book.dev/sdk';
import {layeredLayout, type DataflowGraph} from '@/blockeditor/kit/dataflow';
import {getGraphTarget, setGraphTarget, subscribeGraphPane} from '@/lib/graphPane';
import {useData} from '@/data';
import {useNavigation, useTheme, useTranslation} from '@/providers';
import {PageIcon} from '@/components/PageIcon';
import {ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger} from '@/components/ui/context-menu';
import {MENU_WIDTH_MD} from '@/components/ui/menu-components';
import {useCopyPageLink} from '@/lib/useCopyPageLink';
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

/**
 * Node activation (navigate + re-centre) shared via context so the changing
 * handler doesn't have to live in the memoised node OBJECTS — rebuilding those on
 * every render makes react-flow swallow the click (the HoverContext lesson). The
 * provider value is a stable `useCallback`, so PageNode reads a steady function.
 */
const ActivateContext = createContext<(id: string) => void>(() => undefined);

function PageNode({id, data}: NodeProps<GraphFlowNode>) {
  const {node, isCurrent} = data;
  const {hovered, connected, setHovered} = useContext(HoverContext);
  const activate = useContext(ActivateContext);
  const dimmed = hovered !== null && !connected.has(id);
  const label = node.name?.trim() || 'Untitled';
  return (
    <div
      data-graph-node={isCurrent ? 'current' : 'page'}
      // Keyboard parity with a click: Enter/Space on the focused node navigates.
      // react-flow's own node focus is disabled (`nodesFocusable={false}`) so this
      // is the single focus target — no nested tabstop.
      tabIndex={0}
      role="button"
      aria-label={label}
      aria-current={isCurrent ? 'page' : undefined}
      title={label}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate(id);
        }
      }}
      onMouseEnter={() => setHovered(id)}
      onMouseLeave={() => setHovered(null)}
      className={cn(
        'flex w-48 items-center gap-2 rounded-lg border bg-card px-3 py-2 shadow-sm transition-opacity duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
        isCurrent ? 'border-primary ring-2 ring-primary/30' : 'border-border',
        dimmed && 'opacity-30',
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-border !bg-muted-foreground/40" />
      <PageIcon value={node.icon ?? null} className="shrink-0 leading-none" />
      <span className={cn('min-w-0 truncate text-xs', isCurrent ? 'font-semibold' : 'font-medium')}>{label}</span>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-border !bg-muted-foreground/40" />
    </div>
  );
}

const nodeTypes = {page: PageNode};

const EMPTY: PageGraph = {nodes: [], edges: []};

/**
 * How long to wait after a page-set ping before refetching — coalesces the
 * per-keystroke `subscribePages` burst so the graph doesn't stampede `pageGraph`
 * (the same r2 pattern the Links pane now uses).
 */
const REFRESH_DEBOUNCE_MS = 250;

/** Fetch the whole-library graph, kept live off the page-list subscription. */
function usePageGraph(revision: number): {graph: PageGraph; loading: boolean} {
  const client = useData();
  const [graph, setGraph] = useState<PageGraph>(EMPTY);
  const [loading, setLoading] = useState(false);
  // Monotonic request id: a slow in-flight fetch that resolves after a newer
  // refresh started must not clobber the fresher result.
  const reqId = useRef(0);

  const refresh = useCallback(() => {
    const myReq = ++reqId.current;
    setLoading(true);
    void client
      .pageGraph()
      .then((g) => {
        if (myReq === reqId.current) setGraph(g);
      })
      .catch(() => {
        if (myReq === reqId.current) setGraph(EMPTY);
      })
      .finally(() => {
        if (myReq === reqId.current) setLoading(false);
      });
  }, [client]);

  useEffect(() => {
    refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = client.subscribePages(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, [client, refresh, revision]);

  return {graph, loading};
}

/**
 * The centred page's N-hop neighbourhood (undirected), capped at {@link
 * MAX_NODES} closest-first. With no centre, the highest-degree slice of the whole
 * graph. Returns the kept sub-graph, the size of the neighbourhood BEFORE the cap
 * (`scope`), and whether the {@link MAX_NODES} cap actually truncated (`capped`)
 * — so the pane surfaces the "showing the N closest" note ONLY on real
 * truncation, never merely because a neighbourhood is a subset of the library.
 */
function neighbourhood(
  graph: PageGraph,
  centre: string | null,
): {sub: PageGraph; scope: number; capped: boolean} {
  const total = graph.nodes.length;
  if (total === 0) return {sub: EMPTY, scope: 0, capped: false};

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
  // Pages in view BEFORE the MAX_NODES cap — the centred neighbourhood, or the
  // whole library with no centre. `capped` is a real truncation, not a subset.
  let scope: number;
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
    scope = ordered.length;
    keep = new Set(ordered.slice(0, MAX_NODES));
  } else {
    // No centre: keep the highest-degree nodes.
    const byDegree = [...graph.nodes].sort((a, b) => (adj.get(b.id)?.size ?? 0) - (adj.get(a.id)?.size ?? 0));
    scope = byDegree.length;
    keep = new Set(byDegree.slice(0, MAX_NODES).map((n) => n.id));
  }

  const sub: PageGraph = {
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
  };
  return {sub, scope, capped: scope > MAX_NODES};
}

export function GraphPaneBody() {
  const {t} = useTranslation();
  const {colorScheme} = useTheme();
  const {selectPage, focusPane, closeSplit, openInSplit, pageLabel} = useNavigation();
  const copyLink = useCopyPageLink();

  const [target, setTarget] = useState(getGraphTarget());
  useEffect(() => subscribeGraphPane(() => setTarget(getGraphTarget())), []);
  const centre = target.pageId;

  const {graph, loading} = usePageGraph(target.revision);
  const {sub, scope, capped} = useMemo(() => neighbourhood(graph, centre), [graph, centre]);
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
  const [menuNode, setMenuNode] = useState<GraphFlowNode | null>(null);
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

  // Activate a node (click or Enter/Space): navigate the primary pane to it AND
  // re-centre the graph on it, so the highlight follows the current page and the
  // neighbourhood recomputes around the clicked node. Stable so ActivateContext
  // doesn't churn the memoised node objects.
  const activate = useCallback(
    (id: string): void => {
      focusPane('primary');
      selectPage(id);
      setGraphTarget(id);
    },
    [focusPane, selectPage],
  );

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

      {/* Cap note — fires ONLY on real truncation (the MAX_NODES cap cut nodes),
          not merely because a neighbourhood is a subset of the library. */}
      {hasGraph && capped && (
        <p
          className="shrink-0 bg-muted/40 px-4 py-1 text-[11px] text-muted-foreground"
          data-graph-cap
          aria-live="polite"
        >
          {t('graph.cap', {shown: String(shown), total: String(scope)})}
        </p>
      )}

      <div
        className="relative min-h-0 flex-1"
        role="region"
        aria-label={t('pane.graph')}
      >
        {!hasGraph ? (
          <div
            className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center"
            data-graph-empty
            aria-live="polite"
          >
            <Network className="h-6 w-6 text-muted-foreground/50" aria-hidden />
            <p className="text-sm text-muted-foreground">{loading ? t('graph.loading') : t('graph.empty')}</p>
            {!loading && <p className="max-w-xs text-xs text-muted-foreground/70">{t('graph.emptyHint')}</p>}
          </div>
        ) : (
          <ContextMenu onOpenChange={(open) => !open && setMenuNode(null)}>
            <ContextMenuTrigger asChild>
              <div
                className="h-full"
                onContextMenu={(event) => {
                  // The trigger spans the canvas so React Flow can remain the
                  // event source. Only a node owns this menu; suppress the
                  // otherwise-empty menu on the pane, edges, and controls.
                  if (!(event.target as Element).closest('.react-flow__node')) {
                    event.preventDefault();
                    setMenuNode(null);
                  }
                }}
              >
                <ActivateContext.Provider value={activate}>
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
                      // Node keyboard focus lives on the inner PageNode div (single
                      // tabstop, Enter/Space to activate) — see PageNode.
                      nodesFocusable={false}
                      deleteKeyCode={null}
                      onNodeClick={(_, node) => activate(node.id)}
                      onNodeContextMenu={(_, node) => setMenuNode(node)}
                      proOptions={{hideAttribution: false}}
                    >
                      <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
                      <Controls showInteractive={false} />
                    </ReactFlow>
                  </HoverContext.Provider>
                </ActivateContext.Provider>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className={MENU_WIDTH_MD}>
              <ContextMenuItem disabled={!menuNode} onSelect={() => menuNode && activate(menuNode.id)}>
                <FolderOpen className="mr-2 h-4 w-4" />
                {t('database.rowMenu.open')}
              </ContextMenuItem>
              <ContextMenuItem disabled={!menuNode} onSelect={() => menuNode && openInSplit(menuNode.id)}>
                <Columns2 className="mr-2 h-4 w-4" />
                {t('menu.openSplit')}
              </ContextMenuItem>
              <ContextMenuItem disabled={!menuNode} onSelect={() => menuNode && copyLink(menuNode.id)}>
                <Link2 className="mr-2 h-4 w-4" />
                {t('menu.copyLink')}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )}
      </div>
    </div>
  );
}

export default GraphPaneBody;
