import {createContext, useContext, useEffect, useMemo, useState} from 'react';
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
import {
  ArrowUpRight,
  ChartLine,
  CircleDot,
  Code2,
  GitFork,
  MousePointerClick,
  Sigma,
  SlidersHorizontal,
} from 'lucide-react';
import * as Y from 'yjs';
import {
  dataflowGraph,
  layeredLayout,
  type DataflowGraph,
  type DataflowNode,
  type DataflowOutlet,
} from '@/blockeditor/kit/dataflow';
import {openDoc, subscribeOpenDocs} from '@/lib/openDocs';
import {HOME_PAGE_ID} from '@/lib/homePage';
import {useData} from '@/data';
import {useNavigation, useTheme, useTranslation} from '@/providers';
import {cn} from '@/lib/utils';

/**
 * The dataflow view — the page's reactive wiring as a live node graph in the
 * split pane. Inputs on the left, computations and their consumers flowing
 * right; values update (and pulse) as the document changes; hovering a node
 * spotlights its neighborhood; clicking one scrolls its block into view.
 * Composition is part of the picture: when this page is a database row, the
 * parent's expr columns appear as outlet nodes — the value's way OUT of the
 * page — and clicking one walks up to the parent.
 */

const KIND_META: Record<DataflowNode['kind'], {icon: typeof Code2; chip: string}> = {
  input: {icon: SlidersHorizontal, chip: 'bg-sky-500/15 text-sky-700 dark:text-sky-300'},
  code: {icon: Code2, chip: 'bg-violet-500/15 text-violet-700 dark:text-violet-300'},
  formula: {icon: Sigma, chip: 'bg-violet-500/15 text-violet-700 dark:text-violet-300'},
  chart: {icon: ChartLine, chip: 'bg-amber-500/15 text-amber-700 dark:text-amber-300'},
  light: {icon: CircleDot, chip: 'bg-green-500/15 text-green-700 dark:text-green-300'},
  button: {icon: MousePointerClick, chip: 'bg-pink-500/15 text-pink-700 dark:text-pink-300'},
  outlet: {icon: ArrowUpRight, chip: 'bg-primary/15 text-primary'},
};

type FlowNodeType = Node<{flow: DataflowNode}, 'block'>;

/**
 * Hover spotlight, shared via context so the NODE OBJECTS stay stable:
 * rebuilding the nodes array on hover makes react-flow treat the re-rendered
 * node as a fresh interaction and swallows the click (learned the hard way).
 */
const HoverContext = createContext<{
  hovered: string | null;
  connected: ReadonlySet<string>;
  setHovered: (id: string | null) => void;
    }>({hovered: null, connected: new Set(), setHovered: () => undefined});

function BlockNode({id, data}: NodeProps<FlowNodeType>) {
  const {flow} = data;
  const {icon: Icon, chip} = KIND_META[flow.kind];
  const {hovered, connected, setHovered} = useContext(HoverContext);
  const dimmed = hovered !== null && !connected.has(id);
  return (
    <div
      data-flow-node={flow.kind}
      onMouseEnter={() => setHovered(id)}
      onMouseLeave={() => setHovered(null)}
      className={cn(
        'w-52 rounded-lg border bg-card px-3 py-2 shadow-sm transition-opacity duration-150',
        flow.error ? 'border-destructive/50' : 'border-border',
        flow.kind === 'outlet' && 'border-dashed border-primary/40',
        dimmed && 'opacity-30',
      )}
    >
      {flow.kind !== 'input' && flow.kind !== 'button' && (
        <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-border !bg-muted-foreground/40" />
      )}
      <div className="flex items-center gap-2">
        <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded', chip)}>
          <Icon className="h-3 w-3" />
        </span>
        <span className="min-w-0 truncate text-xs font-semibold">{flow.label}</span>
        {flow.value !== undefined && (
          // Keyed by value: a change remounts the chip and replays the pulse,
          // so you can SEE which values moved when an input changes.
          <span
            key={flow.value}
            className="ob-flow-pulse ml-auto shrink-0 rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
            data-flow-value
          >
            {flow.value}
          </span>
        )}
      </div>
      {flow.source && (
        <p className="mt-1.5 truncate font-mono text-[10px] leading-snug text-muted-foreground/80">{flow.source}</p>
      )}
      {flow.sub && (
        <p className="mt-1 truncate text-[10px] text-muted-foreground" data-flow-outlet-page>
          ↗ {flow.sub}
        </p>
      )}
      {flow.error && <p className="mt-1.5 truncate text-[10px] text-destructive">{flow.error}</p>}
      {flow.kind !== 'outlet' && (
        <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-border !bg-muted-foreground/40" />
      )}
    </div>
  );
}

const nodeTypes = {block: BlockNode};

const EMPTY: DataflowGraph = {nodes: [], edges: []};

/** Subscribe to the primary pane's live doc (re-resolves when panes change). */
function usePrimaryDoc(): {pageId: string | undefined; doc: Y.Doc | undefined} {
  const {panes} = useNavigation();
  const primaryId = panes[0]?.pageId;
  const [, setVersion] = useState(0);
  useEffect(() => subscribeOpenDocs(() => setVersion((v) => v + 1)), []);
  return {pageId: primaryId, doc: openDoc(primaryId)};
}

/**
 * The page's outlets: when it is a database row, every expr column of the
 * parent database that reads one of its exported names.
 */
function useOutlets(pageId: string | undefined): {outlets: DataflowOutlet[]; parentPageId: string | null} {
  const client = useData();
  const [state, setState] = useState<{outlets: DataflowOutlet[]; parentPageId: string | null}>({
    outlets: [],
    parentPageId: null,
  });
  useEffect(() => {
    let cancelled = false;
    setState({outlets: [], parentPageId: null});
    if (!pageId || pageId === HOME_PAGE_ID) return;
    void (async () => {
      const page = await client.getPage(pageId).catch(() => null);
      if (!page?.databaseId || cancelled) return;
      const db = await client.getDatabase(page.databaseId).catch(() => null);
      if (!db || cancelled) return;
      const host = await client.getPage(db.pageId).catch(() => null);
      if (cancelled) return;
      const sub = host?.name?.trim() || db.name?.trim() || '…';
      setState({
        parentPageId: db.pageId,
        outlets: db.schema.properties
          .filter((p) => p.type === 'expr')
          .map((p) => ({id: `outlet:${p.id}`, label: p.name, sub, name: p.cellName ?? p.name})),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [client, pageId]);
  return state;
}

export default function DataflowView() {
  const {t} = useTranslation();
  const {colorScheme} = useTheme();
  const {selectPage, focusPane} = useNavigation();
  const {pageId, doc} = usePrimaryDoc();
  const {outlets, parentPageId} = useOutlets(pageId);

  const [graph, setGraph] = useState<DataflowGraph>(EMPTY);
  useEffect(() => {
    if (!doc) {
      setGraph(EMPTY);
      return;
    }
    let raf = 0;
    const recompute = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setGraph(dataflowGraph(doc, outlets)));
    };
    recompute();
    doc.on('update', recompute);
    return () => {
      doc.off('update', recompute);
      cancelAnimationFrame(raf);
    };
  }, [doc, outlets]);

  // Re-fit when the graph's SHAPE changes (outlets arrive async, blocks come
  // and go) — but never on value ticks, and never fight the user's pan/zoom.
  const [instance, setInstance] = useState<ReactFlowInstance<FlowNodeType, Edge> | null>(null);
  const shape = graph.nodes.map((n) => n.id).join('|');
  useEffect(() => {
    if (instance && shape) void instance.fitView({padding: 0.15, maxZoom: 1.1, duration: 250});
  }, [instance, shape]);

  // Hovering a node spotlights its neighborhood — everything else recedes.
  const [hovered, setHovered] = useState<string | null>(null);
  const hoverValue = useMemo(() => {
    const connected = new Set<string>();
    if (hovered) {
      connected.add(hovered);
      for (const e of graph.edges) {
        if (e.from === hovered || e.to === hovered) {
          connected.add(e.from);
          connected.add(e.to);
        }
      }
    }
    return {hovered, connected, setHovered};
  }, [graph, hovered]);

  // Node objects depend on the graph ALONE — see HoverContext.
  const nodes = useMemo<FlowNodeType[]>(() => {
    const positions = layeredLayout(graph);
    return graph.nodes.map((n) => ({
      id: n.id,
      type: 'block',
      position: positions.get(n.id) ?? {x: 0, y: 0},
      data: {flow: n},
    }));
  }, [graph]);

  const edges = useMemo<Edge[]>(() => {
    return graph.edges.map((e) => {
      const lit = hovered !== null && (e.from === hovered || e.to === hovered);
      const dim = hovered !== null && !lit;
      return {
        id: e.id,
        source: e.from,
        target: e.to,
        label: e.name,
        animated: true,
        labelStyle: {fontSize: 9, fill: 'hsl(var(--muted-foreground))', opacity: dim ? 0.25 : 1},
        labelBgStyle: {fill: 'hsl(var(--background))', fillOpacity: 0.8},
        style: {
          stroke: lit ? 'hsl(var(--primary) / 0.7)' : 'hsl(var(--muted-foreground) / 0.45)',
          strokeWidth: lit ? 1.75 : 1.25,
          opacity: dim ? 0.18 : 1,
          transition: 'opacity 150ms, stroke 150ms',
        },
      };
    });
  }, [graph, hovered]);

  // Clicking a node walks you to its block in the editor pane — or, for an
  // outlet, up to the parent page the value flows into.
  const onNodeClick = (id: string): void => {
    if (id.startsWith('outlet:')) {
      if (parentPageId) {
        // Walk the EDITOR up to the parent — clicking inside this pane just
        // focused it, and selectPage navigates the focused pane.
        focusPane('primary');
        selectPage(parentPageId);
      }
      return;
    }
    const el = document.querySelector(`[data-block-row="${id}"]`);
    if (!el) return;
    el.scrollIntoView({behavior: 'smooth', block: 'center'});
    el.classList.add('obe-locate-flash');
    setTimeout(() => el.classList.remove('obe-locate-flash'), 1300);
  };

  if (graph.nodes.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center" data-dataflow-empty>
        <GitFork className="h-6 w-6 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">{t('flow.empty')}</p>
        <p className="max-w-xs text-xs text-muted-foreground/70">{t('flow.emptyHint')}</p>
      </div>
    );
  }

  return (
    <div className="h-full w-full" data-dataflow-view>
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
    </div>
  );
}
