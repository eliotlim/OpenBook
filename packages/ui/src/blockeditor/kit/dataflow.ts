import type * as Y from 'yjs';
import {blockProp, blockType, rootBlocks, walkBlocks, type BlockMap} from '../model';
import {computeScope, formatValue, INPUT_TYPES} from './scope';

/**
 * The page's reactive wiring as a graph: which blocks publish named values,
 * which blocks read them, and what flows where. Pure extraction — the
 * dataflow view renders it; tests assert on it.
 */

export type DataflowNodeKind = 'input' | 'code' | 'formula' | 'chart' | 'light' | 'button' | 'outlet';

export interface DataflowNode {
  /** The block id — stable, used for edges and click-to-locate. */
  id: string;
  kind: DataflowNodeKind;
  /** The block type ('slider', 'kitchart', …) for the kind badge. */
  type: string;
  /** The published name (publishers) or display label (consumers). */
  label: string;
  /** The current value (or error), formatted for display. */
  value?: string;
  error?: string;
  /** A short preview of the expression/code the block evaluates. */
  source?: string;
  /** Secondary line (outlets: the parent page the value flows into). */
  sub?: string;
}

/**
 * Where an exported name flows OUTSIDE the page: a parent database's expr
 * column reading this page's published value. Composition made visible.
 */
export interface DataflowOutlet {
  /** Node id (e.g. `outlet:<propertyId>`), stable per column. */
  id: string;
  /** The expr column's display name. */
  label: string;
  /** The parent page's title — where the value lands. */
  sub: string;
  /** The exported name the column reads. */
  name: string;
}

export interface DataflowEdge {
  /** `${from}->${to}` — react-flow needs stable unique ids. */
  id: string;
  from: string;
  to: string;
  /** The name carried along this edge. */
  name: string;
}

export interface DataflowGraph {
  nodes: DataflowNode[];
  edges: DataflowEdge[];
}

const IDENT_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

/** Names a source references, limited to names that are actually published. */
export function referencedNames(source: string, published: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  for (const match of source.matchAll(IDENT_RE)) {
    if (published.has(match[0])) seen.add(match[0]);
  }
  return [...seen];
}

const text = (block: BlockMap): string => {
  const t = block.get('text');
  return t ? String(t) : '';
};

const clip = (s: string, max = 80): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)} …` : flat;
};

/**
 * Build the dataflow graph for a document. Document order everywhere, so the
 * layout reads like the page. Edges point from the block that PUBLISHES a
 * name to the block that reads it; a button targeting an input points AT the
 * input (it writes).
 */
export function dataflowGraph(doc: Y.Doc, outlets: DataflowOutlet[] = []): DataflowGraph {
  const {scope, results} = computeScope(doc);
  const nodes: DataflowNode[] = [];
  const edges: DataflowEdge[] = [];

  // First pass: who publishes which name (last publisher wins, like the scope).
  const publisherOf = new Map<string, string>();
  for (const {block} of walkBlocks(rootBlocks(doc))) {
    const id = String(block.get('id'));
    const type = blockType(block) as string;
    const name = blockProp<string>(block, 'name') ?? '';
    const isLiveCode = type === 'code' && Boolean(blockProp<boolean>(block, 'live'));
    if ((INPUT_TYPES.has(type) || isLiveCode || type === 'formula') && name && !publisherOf.has(name)) {
      publisherOf.set(name, id);
    }
  }
  const published = new Set(publisherOf.keys());

  const addEdges = (toId: string, source: string): void => {
    for (const name of referencedNames(source, published)) {
      const from = publisherOf.get(name)!;
      if (from === toId) continue; // self-reference (e.g. shadowing) isn't flow
      edges.push({id: `${from}->${toId}:${name}`, from, to: toId, name});
    }
  };

  for (const {block} of walkBlocks(rootBlocks(doc))) {
    const id = String(block.get('id'));
    const type = blockType(block) as string;
    const name = blockProp<string>(block, 'name') ?? '';
    const result = results.get(id);

    if (INPUT_TYPES.has(type)) {
      if (!name) continue; // unnamed inputs publish nothing — not part of the flow
      nodes.push({id, kind: 'input', type, label: name, value: formatValue(scope[name])});
      continue;
    }

    const isLiveCode = type === 'code' && Boolean(blockProp<boolean>(block, 'live'));
    if (isLiveCode || type === 'formula') {
      const source = isLiveCode ? text(block) : (blockProp<string>(block, 'source') ?? '');
      nodes.push({
        id,
        kind: isLiveCode ? 'code' : 'formula',
        type,
        label: name || (isLiveCode ? 'code' : 'formula'),
        value: result?.error ? undefined : formatValue(result?.value),
        error: result?.error,
        source: clip(source),
      });
      addEdges(id, source);
      continue;
    }

    if (type === 'kitchart' || type === 'statuslight') {
      const source = blockProp<string>(block, 'source') ?? '';
      if (!source.trim()) continue;
      const label =
        type === 'kitchart'
          ? blockProp<string>(block, 'title') || `${blockProp<string>(block, 'kind') ?? 'line'} chart`
          : blockProp<string>(block, 'label') || 'Status';
      nodes.push({id, kind: type === 'kitchart' ? 'chart' : 'light', type, label, source: clip(source)});
      addEdges(id, source);
      continue;
    }

    if (type === 'actionbutton') {
      const target = blockProp<string>(block, 'target') ?? '';
      const targetId = publisherOf.get(target);
      if (!targetId) continue; // a button with no live target isn't part of the flow
      nodes.push({id, kind: 'button', type, label: blockProp<string>(block, 'btnlabel') || 'Button'});
      // The button WRITES the input — flow points at the target.
      edges.push({id: `${id}->${targetId}:${target}`, from: id, to: targetId, name: target});
    }
  }

  // Outlets: a published name the parent page reads gets a terminal node at
  // the graph's edge — the value leaves this page here.
  for (const outlet of outlets) {
    const from = publisherOf.get(outlet.name);
    if (!from) continue;
    nodes.push({id: outlet.id, kind: 'outlet', type: 'outlet', label: outlet.label, sub: outlet.sub});
    edges.push({id: `${from}->${outlet.id}:${outlet.name}`, from, to: outlet.id, name: outlet.name});
  }

  // Drop isolated consumers' dangling references (edges always join known
  // nodes; a publisher may legitimately have no consumers).
  const known = new Set(nodes.map((n) => n.id));
  return {nodes, edges: edges.filter((e) => known.has(e.from) && known.has(e.to))};
}

/** The names this document publishes (what composition can export). */
export function publishedNames(doc: Y.Doc): Set<string> {
  const names = new Set<string>();
  for (const {block} of walkBlocks(rootBlocks(doc))) {
    const type = blockType(block) as string;
    const name = blockProp<string>(block, 'name') ?? '';
    const isLiveCode = type === 'code' && Boolean(blockProp<boolean>(block, 'live'));
    if ((INPUT_TYPES.has(type) || isLiveCode || type === 'formula') && name) names.add(name);
  }
  return names;
}

/**
 * A simple layered layout: each node's column is its dependency depth, its
 * row the order within that column. Returns react-flow-ready positions.
 */
export function layeredLayout(graph: DataflowGraph): Map<string, {x: number; y: number}> {
  const depth = new Map<string, number>();
  const buttons = new Set(graph.nodes.filter((n) => n.kind === 'button').map((n) => n.id));
  const inbound = new Map<string, string[]>();
  for (const e of graph.edges) {
    // Buttons WRITE their target — that edge is an annotation, not a read
    // dependency, and must not push inputs out of the first column.
    if (buttons.has(e.from)) continue;
    const list = inbound.get(e.to) ?? [];
    list.push(e.from);
    inbound.set(e.to, list);
  }
  const resolve = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (seen.has(id)) return 0; // defensive: a cycle can't really happen (ordered pass)
    seen.add(id);
    const parents = inbound.get(id) ?? [];
    const d = parents.length === 0 ? 0 : Math.max(...parents.map((p) => resolve(p, seen))) + 1;
    depth.set(id, d);
    return d;
  };
  for (const node of graph.nodes) resolve(node.id, new Set());

  const COL_W = 252;
  const ROW_H = 104;
  const columns = new Map<number, string[]>();
  for (const node of graph.nodes) {
    const d = depth.get(node.id) ?? 0;
    const col = columns.get(d) ?? [];
    col.push(node.id);
    columns.set(d, col);
  }
  // Center each column vertically against the tallest one — a ragged
  // top-aligned grid reads like a table; a centered one reads like a graph.
  const tallest = Math.max(0, ...[...columns.values()].map((c) => c.length));
  const positions = new Map<string, {x: number; y: number}>();
  for (const [d, ids] of columns) {
    const offset = ((tallest - ids.length) * ROW_H) / 2;
    ids.forEach((id, row) => positions.set(id, {x: d * COL_W, y: offset + row * ROW_H}));
  }
  return positions;
}
