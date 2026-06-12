import {useEffect, useMemo, useState} from 'react';
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
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {GitFork, MousePointerClick, SlidersHorizontal, Code2, Sigma, ChartLine, CircleDot} from 'lucide-react';
import * as Y from 'yjs';
import {dataflowGraph, layeredLayout, type DataflowGraph, type DataflowNode} from '@/blockeditor/kit/dataflow';
import {openDoc, subscribeOpenDocs} from '@/lib/openDocs';
import {useNavigation, useTheme, useTranslation} from '@/providers';
import {cn} from '@/lib/utils';

/**
 * The dataflow view — the page's reactive wiring as a live node graph in the
 * split pane. Inputs on the left, computations and their consumers flowing
 * right; values update as you move sliders or edit code in the editor pane,
 * and clicking a node scrolls its block into view there.
 */

const KIND_META: Record<DataflowNode['kind'], {icon: typeof Code2; chip: string}> = {
  input: {icon: SlidersHorizontal, chip: 'bg-sky-500/15 text-sky-700 dark:text-sky-300'},
  code: {icon: Code2, chip: 'bg-violet-500/15 text-violet-700 dark:text-violet-300'},
  formula: {icon: Sigma, chip: 'bg-violet-500/15 text-violet-700 dark:text-violet-300'},
  chart: {icon: ChartLine, chip: 'bg-amber-500/15 text-amber-700 dark:text-amber-300'},
  light: {icon: CircleDot, chip: 'bg-green-500/15 text-green-700 dark:text-green-300'},
  button: {icon: MousePointerClick, chip: 'bg-pink-500/15 text-pink-700 dark:text-pink-300'},
};

type FlowNodeType = Node<{flow: DataflowNode}, 'block'>;

function BlockNode({data}: NodeProps<FlowNodeType>) {
  const {flow} = data;
  const {icon: Icon, chip} = KIND_META[flow.kind];
  return (
    <div
      data-flow-node={flow.kind}
      className={cn(
        'w-52 rounded-lg border bg-card px-3 py-2 shadow-sm transition-colors',
        flow.error ? 'border-destructive/50' : 'border-border',
      )}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-border !bg-muted-foreground/40" />
      <div className="flex items-center gap-2">
        <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded', chip)}>
          <Icon className="h-3 w-3" />
        </span>
        <span className="min-w-0 truncate text-xs font-semibold">{flow.label}</span>
        {flow.value !== undefined && (
          <span className="ml-auto shrink-0 rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] text-foreground/80" data-flow-value>
            {flow.value}
          </span>
        )}
      </div>
      {flow.source && (
        <p className="mt-1.5 truncate font-mono text-[10px] leading-snug text-muted-foreground/80">{flow.source}</p>
      )}
      {flow.error && <p className="mt-1.5 truncate text-[10px] text-destructive">{flow.error}</p>}
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-border !bg-muted-foreground/40" />
    </div>
  );
}

const nodeTypes = {block: BlockNode};

const EMPTY: DataflowGraph = {nodes: [], edges: []};

/** Subscribe to the primary pane's live doc (re-resolves when panes change). */
function usePrimaryDoc(): Y.Doc | undefined {
  const {panes} = useNavigation();
  const primaryId = panes[0]?.pageId;
  const [, setVersion] = useState(0);
  useEffect(() => subscribeOpenDocs(() => setVersion((v) => v + 1)), []);
  return openDoc(primaryId);
}

export default function DataflowView() {
  const {t} = useTranslation();
  const {colorScheme} = useTheme();
  const doc = usePrimaryDoc();

  const [graph, setGraph] = useState<DataflowGraph>(EMPTY);
  useEffect(() => {
    if (!doc) {
      setGraph(EMPTY);
      return;
    }
    let raf = 0;
    const recompute = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setGraph(dataflowGraph(doc)));
    };
    recompute();
    doc.on('update', recompute);
    return () => {
      doc.off('update', recompute);
      cancelAnimationFrame(raf);
    };
  }, [doc]);

  const {nodes, edges} = useMemo(() => {
    const positions = layeredLayout(graph);
    const nodes: FlowNodeType[] = graph.nodes.map((n) => ({
      id: n.id,
      type: 'block',
      position: positions.get(n.id) ?? {x: 0, y: 0},
      data: {flow: n},
    }));
    const edges: Edge[] = graph.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.name,
      animated: true,
      labelStyle: {fontSize: 9, fill: 'hsl(var(--muted-foreground))'},
      labelBgStyle: {fill: 'hsl(var(--background))', fillOpacity: 0.8},
      style: {stroke: 'hsl(var(--muted-foreground) / 0.45)', strokeWidth: 1.25},
    }));
    return {nodes, edges};
  }, [graph]);

  // Clicking a node walks you to its block in the editor pane.
  const locate = (id: string): void => {
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
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode={colorScheme === 'dark' ? 'dark' : 'light'}
        fitView
        fitViewOptions={{padding: 0.15, maxZoom: 1.1}}
        minZoom={0.2}
        nodesConnectable={false}
        nodesDraggable
        deleteKeyCode={null}
        onNodeClick={(_, node) => locate(node.id)}
        proOptions={{hideAttribution: false}}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
