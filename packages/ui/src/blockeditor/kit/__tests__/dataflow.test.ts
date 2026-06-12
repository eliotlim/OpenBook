import {describe, expect, it} from 'vitest';
import {createDoc} from '../../model';
import {dataflowGraph, layeredLayout, referencedNames} from '../dataflow';

const reactiveDoc = () =>
  createDoc([
    {id: 'sld', type: 'slider', props: {name: 'rate', value: 5, min: 0, max: 10}},
    {id: 'num', type: 'number', props: {name: 'years', value: 3}},
    {id: 'lc', type: 'code', text: 'rate * years', props: {live: true, name: 'total'}},
    {id: 'chart', type: 'kitchart', props: {kind: 'bar', title: 'Growth', source: '[rate, total]'}},
    {id: 'light', type: 'statuslight', props: {label: 'OK?', source: 'total > 10'}},
    {id: 'btn', type: 'actionbutton', props: {btnlabel: 'Bump', action: 'increment', target: 'rate', amount: 1}},
    {id: 'p', type: 'paragraph', text: 'prose stays out of the graph'},
    {id: 'dead', type: 'code', text: '1 + 1', props: {live: false, name: 'file.ts'}},
  ]);

describe('referencedNames', () => {
  it('finds published identifiers only, deduped', () => {
    expect(referencedNames('rate * rate + years - unknown', new Set(['rate', 'years']))).toEqual(['rate', 'years']);
    expect(referencedNames('', new Set(['rate']))).toEqual([]);
  });
});

describe('dataflowGraph', () => {
  it('maps publishers, consumers, and edges; prose and non-live code stay out', () => {
    const graph = dataflowGraph(reactiveDoc());
    expect(graph.nodes.map((n) => [n.id, n.kind])).toEqual([
      ['sld', 'input'],
      ['num', 'input'],
      ['lc', 'code'],
      ['chart', 'chart'],
      ['light', 'light'],
      ['btn', 'button'],
    ]);
    expect(graph.edges.map((e) => `${e.from}->${e.to}:${e.name}`).sort()).toEqual([
      'btn->sld:rate',
      'lc->chart:total',
      'lc->light:total',
      'num->lc:years',
      'sld->chart:rate',
      'sld->lc:rate',
    ]);
  });

  it('carries live values and errors', () => {
    const graph = dataflowGraph(reactiveDoc());
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('sld')?.value).toBe('5');
    expect(byId.get('lc')?.value).toBe('15');
    const bad = dataflowGraph(createDoc([{id: 'x', type: 'code', text: 'nope(', props: {live: true, name: 'x'}}]));
    expect(bad.nodes[0].error).toBeTruthy();
  });

  it('lays out by dependency depth', () => {
    const graph = dataflowGraph(reactiveDoc());
    const pos = layeredLayout(graph);
    // inputs at column 0, live code one column right, its consumers further right
    expect(pos.get('sld')!.x).toBe(0);
    expect(pos.get('lc')!.x).toBeGreaterThan(pos.get('sld')!.x);
    expect(pos.get('light')!.x).toBeGreaterThan(pos.get('lc')!.x);
  });
});

describe('composition outlets', () => {
  it('adds outlet nodes for parent expr columns that read published names', () => {
    const graph = dataflowGraph(reactiveDoc(), [
      {id: 'outlet:p1', label: 'Total', sub: 'Projects', name: 'total'},
      {id: 'outlet:p2', label: 'Untracked', sub: 'Projects', name: 'nope'},
    ]);
    const outlet = graph.nodes.find((n) => n.kind === 'outlet');
    expect(outlet).toMatchObject({id: 'outlet:p1', label: 'Total', sub: 'Projects'});
    expect(graph.nodes.filter((n) => n.kind === 'outlet')).toHaveLength(1); // 'nope' isn't published
    expect(graph.edges.some((e) => e.from === 'lc' && e.to === 'outlet:p1' && e.name === 'total')).toBe(true);
    // outlets sit beyond their publisher
    const pos = layeredLayout(graph);
    expect(pos.get('outlet:p1')!.x).toBeGreaterThan(pos.get('lc')!.x);
  });
});
