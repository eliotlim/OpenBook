/**
 * The shared **parity fixture**: one block-doc exercising every exported block
 * behavior (text, headings, the slider→live-code→chart reactive chain, a
 * formula, status light, progress bar, tabs, accordion, image, table, group,
 * to-do, hostile text). Used by:
 *  - `exportViewer.test.ts` (runtime-selection + determinism assertions), and
 *  - `exportParityFixtures.test.ts` (writes the exported HTML the Playwright
 *    parity harness opens from file:// — packages/web/e2e-viewer).
 *
 * The Playwright suite asserts the exported file, hydrated by the vendored
 * viewer, behaves like the in-app locked page — so these blocks deliberately
 * mirror the app's known-good reactive shapes (see sdk sampleDocument).
 */
import type {PageSnapshot, SpaceSnapshot} from '@book.dev/sdk';
import {createDoc, encodeSnapshot, type NewBlock} from '../../blockeditor/model';
import {blockSnapshotToEditorJs} from '../../blockeditor/exportBlocks';
import type {SiteBundle} from '../exportSite';

/** An 8×8 grey PNG — a real decodable image with zero network. */
export const PARITY_IMAGE_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAD0lEQVR4nGM4gwMwDC0JAMg9mQEkEhIxAAAAAElFTkSuQmCC';

const GROWTH_SOURCE =
  'return {low: Array.from({length: months}, (_, i) => Math.pow(1.03, i / 12)), high: Array.from({length: months}, (_, i) => Math.pow(1.10, i / 12))};';

/** Hostile content: must render as inert TEXT and never break the island. */
export const HOSTILE_TEXT = 'Hostile: </script><script>alert(1)</script> <!-- open comment';

export const PARITY_BLOCKS: NewBlock[] = [
  {id: 'fx-h1', type: 'heading', props: {level: 1}, text: [{t: 'Parity fixture'}]},
  {id: 'fx-p1', type: 'paragraph', text: [
    {t: 'Interactive export. Drag '},
    {t: 'months', a: {b: true}},
    {t: ' to redraw the chart.'},
  ]},
  {id: 'fx-hostile', type: 'paragraph', text: [{t: HOSTILE_TEXT}]},
  {id: 'fx-slider', type: 'slider', props: {name: 'months', label: 'Months', value: 120, min: 1, max: 360, step: 1}},
  {id: 'fx-growth', type: 'code', props: {live: true, name: 'growth', language: 'js', collapsed: true}, text: [{t: GROWTH_SOURCE}]},
  {id: 'fx-formula', type: 'formula', props: {source: 'months * 2', name: 'doubled'}},
  {id: 'fx-chart', type: 'kitchart', props: {kind: 'line', title: 'Growth of £1', source: 'growth'}},
  // Untitled + description-less: the hydrated viewer must NOT render ghost
  // "Chart title" / "Add a description…" placeholders on the locked page.
  {id: 'fx-chart2', type: 'kitchart', props: {kind: 'bar', source: '[months, doubled]'}},
  {id: 'fx-light', type: 'statuslight', props: {label: 'Health', source: 'months <= 120', okAt: 1, warnAt: 0}},
  {id: 'fx-progress', type: 'progressbar', props: {label: 'Used', source: 'months / 360', max: 1, format: 'percent'}},
  {id: 'fx-image', type: 'image', props: {src: PARITY_IMAGE_DATA_URI, alt: 'grey square'}},
  {id: 'fx-table', type: 'table', children: [
    {id: 'fx-tr1', type: 'row', children: [
      {id: 'fx-c11', type: 'cell', text: [{t: 'Name'}]},
      {id: 'fx-c12', type: 'cell', text: [{t: 'Age'}]},
    ]},
    {id: 'fx-tr2', type: 'row', children: [
      {id: 'fx-c21', type: 'cell', text: [{t: 'Ada'}]},
      {id: 'fx-c22', type: 'cell', text: [{t: '36'}]},
    ]},
  ]},
  {id: 'fx-todo', type: 'todo', props: {checked: true}, text: [{t: 'ship the viewer'}]},
  {id: 'fx-acc', type: 'accordion', children: [
    {id: 'fx-as1', type: 'accordionsection', props: {label: 'Details A'}, children: [
      {id: 'fx-ap1', type: 'paragraph', text: [{t: 'Accordion body A'}]},
    ]},
    {id: 'fx-as2', type: 'accordionsection', props: {label: 'Details B'}, children: [
      {id: 'fx-ap2', type: 'paragraph', text: [{t: 'Accordion body B'}]},
    ]},
  ]},
  {id: 'fx-group', type: 'group', props: {name: 'Config'}, children: [
    {id: 'fx-toggle', type: 'toggle', props: {name: 'enabled', label: 'Enabled', value: true}},
    {id: 'fx-gp', type: 'paragraph', text: [{t: 'Group body text'}]},
  ]},
  {id: 'fx-tabs', type: 'tabs', props: {active: 0}, children: [
    {id: 'fx-t1', type: 'tab', props: {label: 'First'}, children: [
      {id: 'fx-tp1', type: 'paragraph', text: [{t: 'first tab body'}]},
    ]},
    {id: 'fx-t2', type: 'tab', props: {label: 'Second'}, children: [
      {id: 'fx-tp2', type: 'paragraph', text: [{t: 'second tab body'}]},
    ]},
  ]},
];

/** A raw block-doc snapshot (what the store holds / the island carries). */
export function parityRawSnapshot(blocks: NewBlock[] = PARITY_BLOCKS): PageSnapshot {
  return {
    editorjs: {blocks: []},
    values: [],
    names: [],
    editor: 'blocks',
    blockdoc: encodeSnapshot(createDoc(blocks)),
  } as never;
}

/** The projected snapshot the app's export action passes to toHtml (the
 *  projection KEEPS the blockdoc, so the island stays lossless). */
export function parityExportSnapshot(blocks: NewBlock[] = PARITY_BLOCKS): PageSnapshot {
  return blockSnapshotToEditorJs(parityRawSnapshot(blocks));
}

const SECOND_PAGE: NewBlock[] = [
  {id: 'p2-p', type: 'paragraph', text: [{t: 'Content of the second page.'}]},
];

/** A two-page, database-free site bundle (mirrors gatherSite's output shape:
 *  projected snapshots in `pages`, raw records in `space`). */
export function paritySiteBundle(): SiteBundle {
  const rootRaw = parityRawSnapshot();
  const secondRaw = parityRawSnapshot(SECOND_PAGE);
  const record = (id: string, name: string, data: PageSnapshot, parentId: string | null) => ({
    id, name, data, hostedDatabaseId: null, databaseId: null, parentId,
    properties: {}, deletedAt: null, createdAt: '2026-07-04T00:00:00.000Z', updatedAt: '2026-07-04T00:00:00.000Z',
  });
  const space: SpaceSnapshot = {
    pages: [record('fx-root', 'Parity fixture', rootRaw, null), record('fx-two', 'Second page', secondRaw, 'fx-root')],
    databases: [],
  };
  return {
    rootId: 'fx-root',
    pages: [
      {id: 'fx-root', title: 'Parity fixture', icon: '🧪', snapshot: blockSnapshotToEditorJs(rootRaw)},
      {id: 'fx-two', title: 'Second page', icon: '', snapshot: blockSnapshotToEditorJs(secondRaw)},
    ],
    space,
  };
}
