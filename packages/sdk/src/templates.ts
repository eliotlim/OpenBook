import type {DataClient} from './client';
import type {PageSnapshot, StoredPage} from './types';
import type {DatabaseSchema} from './database';
import {TITLE_PROPERTY_ID} from './database';
import {buildSampleDocument} from './sampleDocument';

/**
 * The built-in **template gallery**: ready-made pages instantiated client-side
 * through the normal data APIs (no server involvement, same as the sample
 * document). Two shapes:
 *
 *  - **Block-doc artifacts** (the showcases) ship a native block-editor
 *    JSON projection in `blockdoc: {blocks}`. They lean on the whole editor:
 *    reactive inputs feeding *collapsed* live-code, status lights, info/link/
 *    tooltip cards, charts, progress bars, multi-column layouts, callouts, and
 *    `divider`/`notes` blocks so every page doubles as a slide deck with
 *    speaker notes (see blockeditor/present.ts).
 *  - **Databases** (task board, reading list, roadmap, field map) ship a
 *    schema, views, and sample rows; roadmap and field map back the swimlane
 *    and map e2e fixtures.
 *
 * Ids are stable so the gallery, its i18n keys, and the e2e suite can reference
 * a template without depending on display strings.
 */

/**
 * What a template demonstrates, surfaced as gallery chips so the reader knows
 * what a card is before inserting it:
 *  - `interactive` — reactive inputs feeding live code, charts, status lights.
 *  - `slides` — divider-cut slides with speaker notes (present-mode ready).
 *  - `database` — a schema with views and sample rows.
 */
export type TemplateTag = 'interactive' | 'slides' | 'database';

export interface PageTemplate {
  /** Stable identifier (i18n keys + tests hang off this). */
  id: 'grocery-tracker' | 'task-board' | 'reading-list' | 'project-intake' | 'savings-planner' | 'roadmap' | 'field-map' | 'pitch-deck' | 'compound-growth' | 'team-status' | 'product-hq' | 'dashboard';
  /** Emoji shown on the gallery card and applied to the created page. */
  icon: string;
  /** Canonical (English) page name; suffixed when it collides. */
  pageName: string;
  /** What the template shows off — rendered as chips on the gallery card. */
  tags: TemplateTag[];
  /**
   * Canonical (English) text of the leading "how to use this" callout, for
   * templates that don't already open with strong in-doc guidance (the five
   * database fixtures). The gallery passes a localized override through
   * {@link instantiateTemplate}; `create` bakes this English text in by
   * default. Templates whose documents already guide (grocery, pitch deck,
   * team status, and the sample-document copy — which opens with its own
   * intro paragraph) leave it unset.
   */
  guidance?: string;
  /** Creates the page (and database, if any) and returns the stored page.
   *  `guidance` overrides the template's canonical guidance-callout text
   *  (ignored by templates that define none). */
  create: (client: DataClient, name: string, guidance?: string) => Promise<StoredPage>;
}

const emptySnapshot = (blocks: object[]): PageSnapshot => ({
  editorjs: {blocks},
  values: [],
  names: [],
});

// ── The standardized "how to use this" guidance callout ─────────────────────
//
// The five database fixtures — which don't open with strong in-doc guidance of
// their own — lead with one consistent `info` callout: what the template
// demonstrates, then how to try it. The English text below is the canonical
// default; the gallery passes a localized override at instantiation (the ui
// package's `templates.<id>.guidance` i18n keys mirror these strings).

const GUIDANCE = {
  taskBoard:
    'This template shows a task database: the Status property drives the kanban columns, and the same rows back the Table and Calendar views. Try it: drag a card to another column, switch views, or right-click the view to export CSV.',
  readingList:
    'Each shelf is a gallery group, and the same books also list in a Table view. Try it: rate a book, move one to another shelf, or add your own.',
  roadmap:
    'This template shows swimlanes: the Timeline bands and the Board lanes both split by Area. Try it: drag a bar to reschedule, collapse a lane, or move a card between stages.',
  fieldMap:
    'This template shows a map database: rows with a location render as region-coloured pins, and the address-only row waits under Unplaced. Try it: click a pin, geocode the unplaced row, or switch to the Table view.',
  productHq:
    'This template shows two linked databases: each initiative relates to tasks on the Tasks sub-page, and the Progress and Task count columns roll those tasks up. Try it: tick a task done on the sub-page and watch the rollup move, or open the Tasks timeline for the dependency arrows.',
  dashboard:
    'This dashboard reads a sample sales database: the KPI tiles total the rows, and the bar, pie and trend charts group them — all live. Try it: pick a quarter in the control at the top and every tile and chart re-scopes to it at once — or edit a deal on the “… data” sub-page and watch a tile move.',
} as const;

/** The guidance callout as a block-doc block (ids are stable per template). */
const guidanceCallout = (id: string, text: string): object => ({
  id,
  type: 'callout',
  text: [{t: text}],
  props: {variant: 'info'},
});

/** A host-page snapshot: empty, or a single leading guidance callout rendered
 *  (block-doc) above the hosted database view. */
const guidanceSnapshot = (guide?: {id: string; text: string}): PageSnapshot =>
  guide
    ? {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: {blocks: [guidanceCallout(guide.id, guide.text)]}}
    : emptySnapshot([]);

/** A local `YYYY-MM-DD` day string offset by `days` from today. */
const day = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ════════════════════════════════════════════════════════════════════════════
// Block-doc artifacts
//
// Authoring notes (the reactive contract, from blockeditor/kit/scope.ts):
//  • Every input block publishes a value under its `name` (or one derived from
//    `label`). All inputs are gathered *before* code runs, so a chart can read
//    an input no matter where it sits — even inside a column.
//  • LIVE code (`code` + `props.live`) and the charts/status/progress that read
//    its output are evaluated in document (depth-first) order: a consumer must
//    appear AFTER the code it reads. So each slide leads with a small "engine"
//    of collapsed code, then a two-column inputs/results layout below it.
//  • `collapsed: true` hides the code by default (the live readout still shows).
//  • Top-level `divider`s cut slides; top-level `notes` are speaker-only.
// ════════════════════════════════════════════════════════════════════════════

// ── 🛒 Grocery price tracker ─────────────────────────────────────────────────
const GROCERY_BLOCKS = [
  // Slide 1 — title
  {id: 'g-tag', type: 'paragraph', text: [{t: 'A weekly basket, priced across three shops — '}, {t: 'live', a: {b: true}}, {t: '. Drag a shop’s total and the cheapest pick, your savings, and the budget light all recompute.'}]},
  {id: 'g-call', type: 'callout', text: [{t: 'Nothing here is a screenshot. The numbers are computed by code blocks tucked below each slide — click one to see (and change) the maths.'}], props: {variant: 'info'}},
  {id: 'g-notes-1', type: 'notes', text: [{t: 'Open the “…” menu → Present. Each divider is a slide; these notes only show in the presenter view.'}]},
  {id: 'g-div-1', type: 'divider'},

  // Slide 2 — compare shops
  {id: 'g-h2', type: 'heading', text: [{t: 'This week’s shop'}], props: {level: 2}},
  // engine (collapsed)
  {id: 'g-best', type: 'code', text: [{t: 'Math.min(aldi, tesco, ocado)'}], props: {live: true, name: 'best', language: 'js', collapsed: true}},
  {id: 'g-store', type: 'code', text: [{t: 'const m = {Aldi: aldi, Tesco: tesco, Ocado: ocado};\nreturn Object.keys(m).sort((a, b) => m[a] - m[b])[0];'}], props: {live: true, name: 'store', language: 'js', collapsed: true}},
  {id: 'g-saving', type: 'code', text: [{t: 'Math.max(aldi, tesco, ocado) - best'}], props: {live: true, name: 'saving', language: 'js', collapsed: true}},
  {id: 'g-headline', type: 'code', text: [{t: '"Cheapest: " + store + " at £" + best + " — £" + saving + " less than the priciest shop"'}], props: {live: true, name: 'headline', language: 'js', collapsed: true}},
  {
    id: 'g-cols',
    type: 'columns',
    children: [
      {
        id: 'g-col-l',
        type: 'column',
        props: {span: 5},
        children: [
          {id: 'g-budget', type: 'number', props: {name: 'budget', label: 'Weekly budget (£)', value: 120, min: 40, max: 300, step: 5}},
          {id: 'g-aldi', type: 'slider', props: {name: 'aldi', label: 'Aldi basket', value: 86, min: 30, max: 200}},
          {id: 'g-tesco', type: 'slider', props: {name: 'tesco', label: 'Tesco basket', value: 99, min: 30, max: 200}},
          {id: 'g-ocado', type: 'slider', props: {name: 'ocado', label: 'Ocado basket', value: 112, min: 30, max: 200}},
        ],
      },
      {
        id: 'g-col-r',
        type: 'column',
        props: {span: 7},
        children: [
          {id: 'g-bar', type: 'kitchart', props: {kind: 'bar', title: 'Basket by shop (£)', labels: 'Aldi, Tesco, Ocado', source: '[aldi, tesco, ocado]'}},
          {id: 'g-status', type: 'statuslight', props: {label: 'Within the weekly budget', source: 'budget - best', okAt: 0, warnAt: -20}},
          {id: 'g-prog', type: 'progressbar', props: {label: 'Budget used by the cheapest shop', source: 'best / budget', max: 1, format: 'percent'}},
        ],
      },
    ],
  },
  {id: 'g-line', type: 'kitchart', props: {kind: 'line', title: 'Cheapest-basket trend (£)', labels: 'W‑3, W‑2, W‑1, Now', source: '[Math.round(best * 1.18), Math.round(best * 1.07), Math.round(best * 0.98), best]'}},
  {id: 'g-notes-2', type: 'notes', text: [{t: 'Demo the budget light: push the budget below the cheapest basket and it flips amber, then red.'}]},
  {id: 'g-div-2', type: 'divider'},

  // Slide 3 — shop smarter
  {id: 'g-h3', type: 'heading', text: [{t: 'Shop smarter'}], props: {level: 2}},
  {
    id: 'g-cols2',
    type: 'columns',
    children: [
      {
        id: 'g-col2-l',
        type: 'column',
        props: {span: 6},
        children: [
          {id: 'g-tip', type: 'tooltipcard', props: {term: 'Unit price', tip: 'Price per kg or per litre — compare that, not the sticker price, or pack sizes fool you.'}},
          {id: 'g-li1', type: 'list', text: [{t: 'Compare own-label vs branded — usually 15–20% cheaper.'}], props: {kind: 'bullet'}},
          {id: 'g-li2', type: 'list', text: [{t: 'Buy staples in the cheapest shop; top up fresh nearby.'}], props: {kind: 'bullet'}},
          {id: 'g-li3', type: 'list', text: [{t: 'Re-price the basket monthly — prices drift.'}], props: {kind: 'bullet'}},
        ],
      },
      {
        id: 'g-col2-r',
        type: 'column',
        props: {span: 6},
        children: [
          {id: 'g-link', type: 'linkcard', props: {title: 'Compare unit prices', description: 'Track grocery prices across UK supermarkets.', url: 'https://www.trolley.co.uk'}},
        ],
      },
    ],
  },
  {
    id: 'g-table',
    type: 'table',
    props: {header: true},
    children: [
      {id: 'g-tr0', type: 'row', children: [{id: 'g-c00', type: 'cell', text: [{t: 'Item'}]}, {id: 'g-c01', type: 'cell', text: [{t: 'Aldi'}]}, {id: 'g-c02', type: 'cell', text: [{t: 'Tesco'}]}, {id: 'g-c03', type: 'cell', text: [{t: 'Ocado'}]}]},
      {id: 'g-tr1', type: 'row', children: [{id: 'g-c10', type: 'cell', text: [{t: 'Milk (2L)'}]}, {id: 'g-c11', type: 'cell', text: [{t: '£1.45'}]}, {id: 'g-c12', type: 'cell', text: [{t: '£1.65'}]}, {id: 'g-c13', type: 'cell', text: [{t: '£1.70'}]}]},
      {id: 'g-tr2', type: 'row', children: [{id: 'g-c20', type: 'cell', text: [{t: 'Eggs (12)'}]}, {id: 'g-c21', type: 'cell', text: [{t: '£1.99'}]}, {id: 'g-c22', type: 'cell', text: [{t: '£2.30'}]}, {id: 'g-c23', type: 'cell', text: [{t: '£2.55'}]}]},
      {id: 'g-tr3', type: 'row', children: [{id: 'g-c30', type: 'cell', text: [{t: 'Coffee (200g)'}]}, {id: 'g-c31', type: 'cell', text: [{t: '£3.49'}]}, {id: 'g-c32', type: 'cell', text: [{t: '£3.80'}]}, {id: 'g-c33', type: 'cell', text: [{t: '£4.20'}]}]},
    ],
  },
  {id: 'g-call2', type: 'callout', text: [{t: 'Swap one branded staple for the shop’s own label and a £100 basket usually drops to £80–£85.'}], props: {variant: 'success'}},
  {id: 'g-notes-3', type: 'notes', text: [{t: 'Close on the habit, not the app: re-price monthly, shop the cheapest staples, top up fresh locally.'}]},
];

// (🗂️ Project task board and 📚 Reading list are databases — see below.)

// ── 📋 Project intake ────────────────────────────────────────────────────────
// A guided brief: a gated accordion (each stage unlocks the next) whose
// auto-computed completion (`intake.ratio` / `intake.complete`) drives a
// progress bar and a status light, plus a live effort-vs-impact prioritisation.
const PROJECT_INTAKE_BLOCKS = [
  // Slide 1 — title
  {id: 'i-tag', type: 'paragraph', text: [{t: 'Tell us about the work. Each stage '}, {t: 'unlocks the next', a: {b: true}}, {t: ' once it’s filled in — the bar tracks how far along you are.'}]},
  {id: 'i-call', type: 'callout', text: [{t: 'Fill the brief, then check the prioritisation slide to see if it’s worth doing now.'}], props: {variant: 'info'}},
  {id: 'i-notes-1', type: 'notes', text: [{t: 'Use this live in intake calls — fill it in together so scope and priority are agreed before anyone writes code.'}]},
  {id: 'i-div-1', type: 'divider'},

  // Slide 2 — the brief (gated wizard)
  {id: 'i-h2', type: 'heading', text: [{t: 'The brief'}], props: {level: 2}},
  {id: 'i-progress', type: 'progressbar', props: {label: 'Completed', source: 'intake.ratio', max: 1, format: 'percent'}},
  {
    id: 'i-acc',
    type: 'accordion',
    props: {name: 'intake', gated: true},
    children: [
      {
        id: 'i-basics',
        type: 'accordionsection',
        props: {label: 'Basics'},
        children: [
          {id: 'i-basics-p', type: 'paragraph', text: [{t: 'What kind of project is this, and what’s the one-line goal?'}]},
          {
            id: 'i-type',
            type: 'choicecards',
            props: {
              name: 'projectType',
              value: null,
              opts: [
                {label: 'New feature', value: 'feature', icon: '✨', color: 'blue'},
                {label: 'Bug fix', value: 'bugfix', icon: '🐞', color: 'red'},
                {label: 'Research spike', value: 'research', icon: '🔬', color: 'purple'},
                {label: 'Migration', value: 'migration', icon: '📦', color: 'orange'},
              ],
            },
          },
          {id: 'i-summary', type: 'longtext', props: {name: 'summary', value: '', placeholder: 'One sentence: what does done look like?'}},
        ],
      },
      {
        id: 'i-scope',
        type: 'accordionsection',
        props: {label: 'Scope', collapsed: true},
        children: [
          {id: 'i-scope-p', type: 'paragraph', text: [{t: 'Where does it land, and who needs to be in the loop?'}]},
          {
            id: 'i-platform',
            type: 'searchselect',
            props: {
              name: 'platform',
              value: null,
              opts: [
                {label: 'Web', value: 'web'},
                {label: 'Desktop', value: 'desktop'},
                {label: 'Mobile', value: 'mobile'},
                {label: 'API', value: 'api'},
                {label: 'All surfaces', value: 'all'},
              ],
            },
          },
          {id: 'i-teams', type: 'tagfield', props: {name: 'teams', selected: [], freeEntry: true, opts: [{label: 'Design'}, {label: 'Engineering'}, {label: 'Product'}, {label: 'Data'}, {label: 'Support'}]}},
        ],
      },
      {
        id: 'i-details',
        type: 'accordionsection',
        props: {label: 'Details', collapsed: true},
        children: [
          {id: 'i-details-p', type: 'paragraph', text: [{t: 'Spell out the requirements and confirm the pre-flight checks.'}]},
          {id: 'i-req', type: 'richtext', props: {name: 'requirements', runs: [], placeholder: 'Requirements, constraints, links…'}},
          {id: 'i-check-spec', type: 'todo', text: [{t: 'Spec reviewed with the lead'}], props: {checked: false}},
          {id: 'i-check-est', type: 'todo', text: [{t: 'Rough estimate agreed'}], props: {checked: false}},
        ],
      },
    ],
  },
  {id: 'i-notes-2', type: 'notes', text: [{t: 'Don’t skip Scope — naming the platform and teams up front is what stops the surprise re-scoping later.'}]},
  {id: 'i-div-2', type: 'divider'},

  // Slide 3 — prioritisation
  {id: 'i-h3', type: 'heading', text: [{t: 'Worth doing now?'}], props: {level: 2}},
  {id: 'i-verdict', type: 'code', text: [{t: 'impact >= effort * 1.5 ? "Do it now" : impact >= effort ? "Schedule it" : "Park it"'}], props: {live: true, name: 'verdict', language: 'js', collapsed: true}},
  {
    id: 'i-cols',
    type: 'columns',
    children: [
      {
        id: 'i-col-l',
        type: 'column',
        props: {span: 5},
        children: [
          {id: 'i-impact', type: 'slider', props: {name: 'impact', label: 'Impact', value: 7, min: 1, max: 10}},
          {id: 'i-effort', type: 'slider', props: {name: 'effort', label: 'Effort', value: 4, min: 1, max: 10}},
        ],
      },
      {
        id: 'i-col-r',
        type: 'column',
        props: {span: 7},
        children: [
          {id: 'i-status', type: 'statuslight', props: {label: 'Quick win', source: 'impact - effort', okAt: 3, warnAt: 0}},
          {id: 'i-bar', type: 'kitchart', props: {kind: 'bar', title: 'Effort vs impact', labels: 'Effort, Impact', source: '[effort, impact]'}},
        ],
      },
    ],
  },
  {id: 'i-tip', type: 'tooltipcard', props: {term: 'Quick win', tip: 'High impact for low effort — the top-left of an effort/impact grid. Do these first.'}},
  {id: 'i-notes-3', type: 'notes', text: [{t: 'The verdict is a heuristic, not a mandate — use it to start the conversation, not end it.'}]},
  {id: 'i-div-3', type: 'divider'},

  // Slide 4 — submit
  {id: 'i-h4', type: 'heading', text: [{t: 'Ready to submit'}], props: {level: 2}},
  {id: 'i-submit-status', type: 'statuslight', props: {label: 'All required fields complete', source: 'intake.complete', okAt: 1, warnAt: 1}},
  {id: 'i-call2', type: 'callout', text: [{t: 'When the light turns green, every stage is filled — share this page with the team to kick off.'}], props: {variant: 'success'}},
  {id: 'i-notes-4', type: 'notes', text: [{t: 'Hand-off close: green light → assign an owner and a target date, then move it onto the task board.'}]},
];

// ── 💰 Savings & investing ───────────────────────────────────────────────────
const SAVINGS_BLOCKS = [
  // Slide 1 — title
  {id: 's-tag', type: 'paragraph', text: [{t: 'A plan in two parts: a '}, {t: 'safety net', a: {b: true}}, {t: ' first, then watch contributions '}, {t: 'compound', a: {b: true}}, {t: ' toward a goal.'}]},
  {id: 's-call', type: 'callout', text: [{t: 'Drag the contribution, rate and horizon — the projection, goal light and shortfall all recompute. The maths sits in a code block you can open.'}], props: {variant: 'info'}},
  {id: 's-notes-1', type: 'notes', text: [{t: 'Caveat up front: illustrative compounding, not advice. Real returns vary and aren’t guaranteed.'}]},
  {id: 's-div-1', type: 'divider'},

  // Slide 2 — the projection
  {id: 's-h2', type: 'heading', text: [{t: 'Your money, compounding'}], props: {level: 2}},
  {id: 's-proj', type: 'code', text: [{t: 'const r = rate / 100;\nlet bal = initial;\nconst Invested = [Math.round(initial)], Projected = [Math.round(initial)];\nfor (let y = 1; y <= years; y++) {\n  bal = (bal + monthly * 12) * (1 + r);\n  Invested.push(Math.round(initial + monthly * 12 * y));\n  Projected.push(Math.round(bal));\n}\nreturn {Invested, Projected};'}], props: {live: true, name: 'projection', language: 'js', collapsed: true}},
  {id: 's-final', type: 'code', text: [{t: 'projection.Projected[projection.Projected.length - 1]'}], props: {live: true, name: 'final', language: 'js', collapsed: true}},
  {id: 's-headline', type: 'code', text: [{t: '"After " + years + " years: £" + Math.round(final).toLocaleString() + " — you put in £" + Math.round(initial + monthly * 12 * years).toLocaleString()'}], props: {live: true, name: 'headline', language: 'js', collapsed: true}},
  {
    id: 's-cols',
    type: 'columns',
    children: [
      {
        id: 's-col-l',
        type: 'column',
        props: {span: 5},
        children: [
          {id: 's-initial', type: 'number', props: {name: 'initial', label: 'Starting savings (£)', value: 2000, min: 0, max: 100000, step: 500}},
          {id: 's-monthly', type: 'slider', props: {name: 'monthly', label: 'Monthly contribution (£)', value: 300, min: 0, max: 2000}},
          {id: 's-rate', type: 'slider', props: {name: 'rate', label: 'Annual return (%)', value: 6, min: 0, max: 12}},
          {id: 's-years', type: 'slider', props: {name: 'years', label: 'Years', value: 20, min: 1, max: 40}},
          {id: 's-goal', type: 'number', props: {name: 'goal', label: 'Goal (£)', value: 150000, min: 0, max: 1000000, step: 5000}},
        ],
      },
      {
        id: 's-col-r',
        type: 'column',
        props: {span: 7},
        children: [
          {id: 's-area', type: 'kitchart', props: {kind: 'area', title: 'Balance by year', source: 'projection'}},
          {id: 's-status', type: 'statuslight', props: {label: 'On track for your goal', source: 'final - goal', okAt: 0, warnAt: -60000}},
          {id: 's-prog', type: 'progressbar', props: {label: 'Progress to goal', source: 'final / goal', max: 1, format: 'percent'}},
        ],
      },
    ],
  },
  {id: 's-notes-2', type: 'notes', text: [{t: 'The gap between the two curves is growth doing the work. Drag the rate slider to show how much the return matters over 20 years.'}]},
  {id: 's-div-2', type: 'divider'},

  // Slide 3 — safety net first
  {id: 's-h3', type: 'heading', text: [{t: 'Safety net first'}], props: {level: 2}},
  {id: 's-months', type: 'code', text: [{t: 'Math.round(savings / expenses * 10) / 10'}], props: {live: true, name: 'months', language: 'js', collapsed: true}},
  {
    id: 's-cols2',
    type: 'columns',
    children: [
      {
        id: 's-col2-l',
        type: 'column',
        props: {span: 5},
        children: [
          {id: 's-savings', type: 'number', props: {name: 'savings', label: 'Easy-access savings (£)', value: 8000, min: 0, max: 100000, step: 500}},
          {id: 's-expenses', type: 'number', props: {name: 'expenses', label: 'Monthly expenses (£)', value: 1800, min: 200, max: 10000, step: 100}},
        ],
      },
      {
        id: 's-col2-r',
        type: 'column',
        props: {span: 7},
        children: [
          {id: 's-emergency', type: 'statuslight', props: {label: 'Emergency fund', source: 'savings / expenses', okAt: 6, warnAt: 3}},
          {id: 's-emprog', type: 'progressbar', props: {label: 'Months covered (target 6)', source: 'savings / expenses / 6', max: 1, format: 'percent'}},
          {id: 's-runway', type: 'kitchart', props: {kind: 'bar', title: 'Months of runway', labels: 'You, Target', source: '[months, 6]'}},
        ],
      },
    ],
  },
  {id: 's-call2', type: 'callout', text: [{t: 'Aim for 3–6 months of expenses in easy-access savings before investing the rest. The light goes green at six.'}], props: {variant: 'warn'}},
  {id: 's-notes-3', type: 'notes', text: [{t: 'Order of operations: safety net → high-interest debt → invest. Don’t skip to the fun slide first.'}]},
  {id: 's-div-3', type: 'divider'},

  // Slide 4 — recap
  {id: 's-h4', type: 'heading', text: [{t: 'The plan'}], props: {level: 2}},
  {id: 's-quote', type: 'quote', text: [{t: 'Do not save what is left after spending; spend what is left after saving.'}]},
  {id: 's-link', type: 'linkcard', props: {title: 'How compound interest works', description: 'A plain-English primer.', url: 'https://www.investor.gov/financial-tools-calculators/calculators/compound-interest-calculator'}},
  {id: 's-notes-4', type: 'notes', text: [{t: 'One ask to close on: automate the monthly contribution so the plan happens without willpower.'}]},
];

// ── 📽️ Pitch deck ────────────────────────────────────────────────────────────
// A present-first showcase: five slides (title · agenda · a live revenue-mix
// donut · a quote · the ask), each with a speaker `notes` block, so the ⋯ →
// Present flow lands on a real deck. The donut slide is the interactive core:
// three sliders feed the chart and a recurring-revenue status light.
const PITCH_DECK_BLOCKS = [
  // Slide 1 — title
  {id: 'pd-h1', type: 'heading', text: [{t: 'Brightloop'}], props: {level: 1}},
  {id: 'pd-tag', type: 'paragraph', text: [{t: 'The pitch as a '}, {t: 'live document', a: {b: true}}, {t: ' — the numbers on slide 3 recompute while you talk.'}]},
  {id: 'pd-call', type: 'callout', text: [{t: 'Open the ⋯ menu → Present to run this as a deck.'}], props: {variant: 'info'}},
  {id: 'pd-notes-1', type: 'notes', text: [{t: 'Thirty seconds, tops: who you are, what Brightloop is, why the room should care. Land the tagline, then advance — the deck itself makes the “live document” point on slide 3.'}]},
  {id: 'pd-div-1', type: 'divider'},

  // Slide 2 — agenda
  {id: 'pd-h2', type: 'heading', text: [{t: 'Agenda'}], props: {level: 2}},
  {id: 'pd-ag1', type: 'list', text: [{t: 'The problem — decks go stale the moment they’re exported.'}], props: {kind: 'number'}},
  {id: 'pd-ag2', type: 'list', text: [{t: 'The product — one page that is both the model and the deck.'}], props: {kind: 'number'}},
  {id: 'pd-ag3', type: 'list', text: [{t: 'Revenue mix — live, draggable, no screenshots.'}], props: {kind: 'number'}},
  {id: 'pd-ag4', type: 'list', text: [{t: 'What early users say.'}], props: {kind: 'number'}},
  {id: 'pd-ag5', type: 'list', text: [{t: 'The ask.'}], props: {kind: 'number'}},
  {id: 'pd-notes-2', type: 'notes', text: [{t: 'Signpost, don’t read: five stops, four minutes. Flag that slide 3 is interactive so nobody mistakes the demo for a rehearsed video.'}]},
  {id: 'pd-div-2', type: 'divider'},

  // Slide 3 — the live donut
  {id: 'pd-h3', type: 'heading', text: [{t: 'Revenue mix — live'}], props: {level: 2}},
  {id: 'pd-recurring', type: 'code', text: [{t: 'Math.round(subs / (subs + services + partners) * 100)'}], props: {live: true, name: 'recurring', language: 'js', collapsed: true}},
  {
    id: 'pd-cols',
    type: 'columns',
    children: [
      {
        id: 'pd-col-l',
        type: 'column',
        props: {span: 5},
        children: [
          {id: 'pd-subs', type: 'slider', props: {name: 'subs', label: 'Subscriptions (£k/yr)', value: 62, min: 0, max: 200}},
          {id: 'pd-services', type: 'slider', props: {name: 'services', label: 'Services (£k/yr)', value: 26, min: 0, max: 200}},
          {id: 'pd-partners', type: 'slider', props: {name: 'partners', label: 'Partnerships (£k/yr)', value: 12, min: 0, max: 200}},
        ],
      },
      {
        id: 'pd-col-r',
        type: 'column',
        props: {span: 7},
        children: [
          {id: 'pd-donut', type: 'kitchart', props: {kind: 'donut', title: 'Revenue by stream (£k/yr)', labels: 'Subscriptions, Services, Partnerships', source: '[subs, services, partners]'}},
          {id: 'pd-status', type: 'statuslight', props: {label: 'Recurring revenue ≥ 60%', source: 'recurring', okAt: 60, warnAt: 45}},
        ],
      },
    ],
  },
  {id: 'pd-notes-3', type: 'notes', text: [{t: 'The money moment: drag Services up until the light drops to amber, then pull Subscriptions back up until recurring clears 60% and watch it recover. The maths is a one-line code block above the columns — open it if anyone asks.'}]},
  {id: 'pd-div-3', type: 'divider'},

  // Slide 4 — the quote
  {id: 'pd-h4', type: 'heading', text: [{t: 'What early users say'}], props: {level: 2}},
  {id: 'pd-quote', type: 'quote', text: [{t: 'We pitched with the model itself — when the room asked “what if churn doubles?”, we dragged a slider instead of promising a follow-up.'}]},
  {id: 'pd-notes-4', type: 'notes', text: [{t: 'Pause after reading the quote — let it sit. If pressed for attribution, it’s a composite of three design-partner calls; offer intros rather than names.'}]},
  {id: 'pd-div-4', type: 'divider'},

  // Slide 5 — the ask
  {id: 'pd-h5', type: 'heading', text: [{t: 'The ask'}], props: {level: 2}},
  {id: 'pd-ask', type: 'paragraph', text: [{t: 'We’re raising '}, {t: '£1.2M', a: {b: true}}, {t: ' to take Brightloop from private beta to launch: two engineers, one designer, and twelve months of runway.'}]},
  {id: 'pd-call2', type: 'callout', text: [{t: 'Make it yours: duplicate this page, swap in your numbers, and pitch with live charts instead of screenshots.'}], props: {variant: 'success'}},
  {id: 'pd-notes-5', type: 'notes', text: [{t: 'Close with the concrete next step: a 30-minute working session in the live model this week. Stop talking after the ask.'}]},
];

// ── 🚦 Team status dashboard ─────────────────────────────────────────────────
// The kit-breadth showcase, as a single-page dashboard (no slides): a **locked
// group** whose controls stay live for readers (toggle, dropdown, a kudos
// counter driven by an action button, a formula and a status light reading it),
// a **funnel** chart (a kind no other template uses), a **tabs** container, and
// a cross-page **sync** key — the same Pulse group pasted on another page stays
// in lockstep under `team-pulse`.
const TEAM_STATUS_BLOCKS = [
  {id: 'td-tag', type: 'paragraph', text: [{t: 'One page the whole team reads: a '}, {t: 'locked', a: {b: true}}, {t: ' Pulse panel whose controls stay live, a delivery funnel, and the week’s rituals in tabs.'}]},
  {id: 'td-call', type: 'callout', text: [{t: 'The Pulse group is locked (the 🔒 in its header): its text and layout are frozen, but readers keep every control. It also syncs across pages under the sync key “team-pulse” — paste the same group on another page and the two stay in lockstep.'}], props: {variant: 'info'}},

  // The locked, synced control panel.
  {id: 'td-h2', type: 'heading', text: [{t: 'Team pulse'}], props: {level: 2}},
  {
    id: 'td-group',
    type: 'group',
    props: {name: 'Pulse', locked: true, sync: 'team-pulse'},
    children: [
      {id: 'td-g-note', type: 'paragraph', text: [{t: 'This panel is locked — this very sentence can’t be edited in place — yet every control below still works.'}]},
      {id: 'td-oncall', type: 'toggle', props: {name: 'onCall', label: 'On-call rotation active', value: true}},
      {id: 'td-focus', type: 'dropdown', props: {name: 'focus', label: 'Focus this week', value: 'shipping', opts: [{label: 'Shipping'}, {label: 'Stability'}, {label: 'Growth'}]}},
      {id: 'td-kudos', type: 'number', props: {name: 'kudos', label: 'Kudos given', value: 2, min: 0, max: 99, step: 1}},
      {id: 'td-give', type: 'actionbutton', props: {btnlabel: 'Give kudos', action: 'increment', target: 'kudos', amount: 1}},
      // Inputs inside a named group publish namespaced — pulse.kudos.value —
      // which is exactly what this formula (and the light below) read.
      {id: 'td-score', type: 'formula', props: {name: 'morale', source: 'pulse.kudos.value * 10 + (pulse.onCall.value ? 5 : 0)'}},
      {id: 'td-light', type: 'statuslight', props: {label: 'Momentum', source: 'pulse.kudos.value', okAt: 3, warnAt: 1}},
    ],
  },

  // The delivery funnel: a chart kind no other template exercises.
  {id: 'td-h3', type: 'heading', text: [{t: 'Delivery pipeline'}], props: {level: 2}},
  {id: 'td-pipe', type: 'code', text: [{t: '({Ideas: 24, Building: 12, "In review": 7, Shipped: shipped})'}], props: {live: true, name: 'pipeline', language: 'js', collapsed: true}},
  {
    id: 'td-cols',
    type: 'columns',
    children: [
      {
        id: 'td-col-l',
        type: 'column',
        props: {span: 5},
        children: [
          {id: 'td-shipped', type: 'number', props: {name: 'shipped', label: 'Shipped this quarter', value: 5, min: 0, max: 50, step: 1}},
          {id: 'td-tip', type: 'tooltipcard', props: {term: 'Funnel', tip: 'Each stage narrows: ideas → building → review → shipped. Step the shipped count and the funnel redraws.'}},
        ],
      },
      {
        id: 'td-col-r',
        type: 'column',
        props: {span: 7},
        children: [
          {id: 'td-funnel', type: 'kitchart', props: {kind: 'funnel', title: 'Ideas → Shipped', source: 'pipeline'}},
        ],
      },
    ],
  },

  // The week's rituals, in a tabs container.
  {id: 'td-h4', type: 'heading', text: [{t: 'Rituals'}], props: {level: 2}},
  {
    id: 'td-tabs',
    type: 'tabs',
    props: {name: 'Rituals', active: 0},
    children: [
      {
        id: 'td-tab-week',
        type: 'tab',
        props: {label: 'This week'},
        children: [
          {id: 'td-t1', type: 'todo', text: [{t: 'Monday kick-off — pick the focus in the Pulse panel'}], props: {checked: true}},
          {id: 'td-t2', type: 'todo', text: [{t: 'Thursday demo — show, don’t tell'}], props: {checked: false}},
        ],
      },
      {
        id: 'td-tab-next',
        type: 'tab',
        props: {label: 'Next week'},
        children: [
          {id: 'td-n1', type: 'list', text: [{t: 'Rotate the on-call — flip the Pulse toggle'}], props: {kind: 'bullet'}},
          {id: 'td-n2', type: 'list', text: [{t: 'Reset the kudos counter at retro'}], props: {kind: 'bullet'}},
        ],
      },
    ],
  },
  {id: 'td-call2', type: 'callout', text: [{t: 'Make it yours: rename the Pulse group, change its sync key, and unlock it (the 🔓 in the group header) to re-arrange the controls.'}], props: {variant: 'success'}},
];

// ════════════════════════════════════════════════════════════════════════════
// Databases (the task board, reading list, and the swimlane + map e2e fixtures)
// ════════════════════════════════════════════════════════════════════════════

// ── 🗂️ Project task board ────────────────────────────────────────────────────
// A kanban: a `status` property drives the board columns; priority, assignee,
// due date and a bar-style effort number round it out. Opens on the board.
const TASK_BOARD_SCHEMA: DatabaseSchema = {
  properties: [
    {
      id: 'p_status',
      name: 'Status',
      type: 'status',
      options: [
        {id: 'opt_todo', label: 'Backlog', color: 'gray', group: 'todo'},
        {id: 'opt_doing', label: 'In progress', color: 'blue', group: 'in_progress'},
        {id: 'opt_done', label: 'Done', color: 'green', group: 'complete'},
      ],
    },
    {
      id: 'p_priority',
      name: 'Priority',
      type: 'select',
      options: [
        {id: 'opt_high', label: 'High', color: 'red'},
        {id: 'opt_med', label: 'Medium', color: 'yellow'},
        {id: 'opt_low', label: 'Low', color: 'gray'},
      ],
    },
    {id: 'p_assignee', name: 'Assignee', type: 'text'},
    {id: 'p_due', name: 'Due', type: 'date'},
    {id: 'p_effort', name: 'Effort', type: 'number', numberDisplay: 'bar', numberTarget: 8},
  ],
  views: [
    // Board first → the page opens as a kanban grouped by status; a table backs
    // it, and a calendar lays the same tasks out on a month grid by due date.
    {id: 'v_board', name: 'Board', type: 'board', filters: [], sorts: [], groupByPropertyId: 'p_status'},
    {id: 'v_table', name: 'Table', type: 'table', filters: [], sorts: []},
    {id: 'v_calendar', name: 'Calendar', type: 'calendar', filters: [], sorts: [], datePropertyId: 'p_due'},
  ],
};

const TASK_BOARD_ROWS = [
  {name: 'Draft the API contract', properties: {p_status: 'opt_doing', p_priority: 'opt_high', p_assignee: 'Ada', p_due: day(2), p_effort: 3}},
  {name: 'Build the onboarding flow', properties: {p_status: 'opt_doing', p_priority: 'opt_med', p_assignee: 'Lin', p_due: day(4), p_effort: 5}},
  {name: 'Spike: auth options', properties: {p_status: 'opt_todo', p_priority: 'opt_high', p_assignee: 'Ada', p_due: day(1), p_effort: 2}},
  {name: 'Write the migration plan', properties: {p_status: 'opt_todo', p_priority: 'opt_low', p_assignee: 'Sam', p_due: day(6), p_effort: 5}},
  {name: 'Wire up billing', properties: {p_status: 'opt_todo', p_priority: 'opt_med', p_assignee: 'Lin', p_due: day(9), p_effort: 8}},
  {name: 'Set up CI', properties: {p_status: 'opt_done', p_priority: 'opt_med', p_assignee: 'Sam', p_effort: 3}},
  {name: 'Design review', properties: {p_status: 'opt_done', p_priority: 'opt_low', p_assignee: 'Ada', p_effort: 1}},
];

// ── 📚 Reading list ──────────────────────────────────────────────────────────
// A shelf-grouped gallery of books, with authors and star ratings; a table backs it.
//
// Covers (so the gallery renders real cards, not empty slots): tiny (<300 B) raster
// PNGs, inlined as `data:` URLs on the `files`-typed `p_cover` cells. Deliberately
// NOT routed through the content-addressed asset store — the `files` property and
// the gallery cover render a URL string straight into `<img src>` with no
// asset-resolution seam, so a store `assetId` wouldn't load there, and this seeds
// identically on both transports (web PGlite + desktop IPC) with no upload call.
// PNG, never SVG — honouring the store's image allowlist even though nothing is
// stored (an `<img src="data:image/png…">` executes no script). One per shelf so
// each gallery group leads with a cover.
const COVER_TEAL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAAB4CAIAAADqjOKhAAAAsklEQVR42u3ZMQ2AMBRF0YpgR1INoAQPGKidrt2R0KQq2FlJmvJzkmvgjC8vbUd+tV9n4BIwMDAwMDAwMDAwMDAwMDAwMDAwMDAw8BLge/S/BAwMDAwMDAwMDAwMDAwMDAwMDAwMHADseQAGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYG/gIurc4PGBgYGBgYGBgYOADYWgIGBgYGBgYGBgYGBgYO0wNsxNp6TrTOmAAAAABJRU5ErkJggg==';
const COVER_ORANGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAAB4CAIAAADqjOKhAAAAsklEQVR42u3ZMQ2AMBRF0SpBAlKqBw24wEo1dKkClu5d2VlJmvJzkmvgjC8vnXl7VY89cAkYGBgYGBgYGBgYGBgYGBgYGBgYGBgYeAnwuNtfAgYGBgYGBgYGBgYGBgYGBgYGBgYGDgD2PAADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDfwH3cs0PGBgYGBgYGBgYOADYWgIGBgYGBgYGBgYGBgYO0wM4vRK/kEih/QAAAABJRU5ErkJggg==';
const COVER_BLUE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAAB4CAIAAADqjOKhAAAAsklEQVR42u3ZMQ2AMBRF0WpBAxqqBgEIQkSXGunCVANVwM5K0pSfk1wDZ3x5acvnq/0ogUvAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwEuAWx9/CRgYGBgYGBgYGBgYGBgYGBgYGBgYOADY8wAMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM/AV81Xt+wMDAwMDAwMDAwAHA1hIwMDAwMDAwMDAwMDBwmB4f7fGQa+V+2QAAAABJRU5ErkJggg==';

const READING_SCHEMA: DatabaseSchema = {
  properties: [
    {
      id: 'p_shelf',
      name: 'Shelf',
      type: 'select',
      options: [
        {id: 'opt_toread', label: 'To read', color: 'gray'},
        {id: 'opt_reading', label: 'Reading', color: 'blue'},
        {id: 'opt_done', label: 'Finished', color: 'green'},
      ],
    },
    {id: 'p_author', name: 'Author', type: 'text'},
    {id: 'p_rating', name: 'Rating', type: 'rating'},
    {id: 'p_cover', name: 'Cover', type: 'files'},
  ],
  views: [
    {id: 'v_gallery', name: 'Gallery', type: 'gallery', filters: [], sorts: [], groupByPropertyId: 'p_shelf', coverPropertyId: 'p_cover'},
    {id: 'v_table', name: 'Table', type: 'table', filters: [], sorts: []},
  ],
};

const READING_ROWS = [
  {name: 'The Design of Everyday Things', properties: {p_shelf: 'opt_reading', p_author: 'Don Norman', p_rating: 4, p_cover: [COVER_ORANGE]}},
  {name: 'Project Hail Mary', properties: {p_shelf: 'opt_reading', p_author: 'Andy Weir', p_rating: 5}},
  {name: 'Thinking, Fast and Slow', properties: {p_shelf: 'opt_toread', p_author: 'Daniel Kahneman', p_cover: [COVER_TEAL]}},
  {name: 'Designing Data-Intensive Applications', properties: {p_shelf: 'opt_toread', p_author: 'Martin Kleppmann'}},
  {name: 'The Pragmatic Programmer', properties: {p_shelf: 'opt_done', p_author: 'Hunt & Thomas', p_rating: 5, p_cover: [COVER_BLUE]}},
  {name: 'Deep Work', properties: {p_shelf: 'opt_done', p_author: 'Cal Newport', p_rating: 4}},
];

// ── Product roadmap ──────────────────────────────────────────────────────────
const ROADMAP_SCHEMA: DatabaseSchema = {
  properties: [
    {
      id: 'p_stage',
      name: 'Stage',
      type: 'status',
      options: [
        {id: 'opt_idea', label: 'Idea', color: 'gray', group: 'todo'},
        {id: 'opt_build', label: 'Building', color: 'blue', group: 'in_progress'},
        {id: 'opt_shipped', label: 'Shipped', color: 'green', group: 'complete'},
      ],
    },
    {
      id: 'p_area',
      name: 'Area',
      type: 'select',
      options: [
        {id: 'opt_core', label: 'Core', color: 'blue'},
        {id: 'opt_growth', label: 'Growth', color: 'pink'},
        {id: 'opt_infra', label: 'Infra', color: 'orange'},
      ],
    },
    {id: 'p_when', name: 'When', type: 'date', dateRange: true},
  ],
  views: [
    // Timeline bands by Area (Gantt swimlanes); board columns by Stage with a
    // second Area swimlane (horizontal lanes). Both demonstrate the swimlane
    // grouping out of the box off the same `p_area` select.
    {id: 'v_timeline', name: 'Timeline', type: 'timeline', filters: [], sorts: [], datePropertyId: 'p_when', groupByPropertyId: 'p_area'},
    {id: 'v_board', name: 'Board', type: 'board', filters: [], sorts: [], groupByPropertyId: 'p_stage', subGroupByPropertyId: 'p_area'},
    {id: 'v_table', name: 'Table', type: 'table', filters: [], sorts: []},
  ],
};

const ROADMAP_ROWS = [
  {name: 'Self-serve onboarding', properties: {p_stage: 'opt_build', p_area: 'opt_growth', p_when: {start: day(-7), end: day(14)}}},
  {name: 'Realtime collaboration', properties: {p_stage: 'opt_idea', p_area: 'opt_core', p_when: {start: day(21), end: day(60)}}},
  {name: 'Usage analytics dashboard', properties: {p_stage: 'opt_idea', p_area: 'opt_growth', p_when: {start: day(10), end: day(30)}}},
  {name: 'Single sign-on', properties: {p_stage: 'opt_shipped', p_area: 'opt_infra', p_when: {start: day(-30), end: day(-10)}}},
];

// ── Field map ────────────────────────────────────────────────────────────────
// A location database: a `location` property places each site on the map view,
// a `select` (Region) colours the markers, and an `Address` text property lets
// the unplaced row be geocoded into coords. One row (Lisbon) carries only an
// address — no coords — to exercise the unplaced/geocode affordance.

const FIELD_MAP_SCHEMA: DatabaseSchema = {
  properties: [
    {
      id: 'p_region',
      name: 'Region',
      type: 'select',
      options: [
        {id: 'opt_americas', label: 'Americas', color: 'blue'},
        {id: 'opt_emea', label: 'EMEA', color: 'green'},
        {id: 'opt_apac', label: 'APAC', color: 'orange'},
      ],
    },
    {
      id: 'p_kind',
      name: 'Kind',
      type: 'select',
      options: [
        {id: 'opt_hq', label: 'HQ', color: 'purple'},
        {id: 'opt_office', label: 'Office', color: 'gray'},
        {id: 'opt_partner', label: 'Partner', color: 'yellow'},
      ],
    },
    {id: 'p_address', name: 'Address', type: 'text'},
    {id: 'p_place', name: 'Location', type: 'location'},
    {id: 'p_headcount', name: 'Headcount', type: 'number'},
  ],
  views: [
    // Markers placed off `p_place`, coloured by Region, clustered when dense; an
    // Address property is offered for geocoding the one row with no coords.
    {
      id: 'v_map',
      name: 'Map',
      type: 'map',
      filters: [],
      sorts: [],
      geoPropertyId: 'p_place',
      addressPropertyId: 'p_address',
      groupByPropertyId: 'p_region',
      mapClustered: true,
    },
    {id: 'v_table', name: 'Table', type: 'table', filters: [], sorts: []},
  ],
};

const FIELD_MAP_ROWS = [
  // Americas
  {name: 'San Francisco HQ', properties: {p_region: 'opt_americas', p_kind: 'opt_hq', p_headcount: 180, p_address: '1 Market St, San Francisco, CA', p_place: {lat: 37.7937, lng: -122.3965, label: 'San Francisco HQ', address: '1 Market St, San Francisco, CA'}}},
  {name: 'New York office', properties: {p_region: 'opt_americas', p_kind: 'opt_office', p_headcount: 95, p_address: '11 Madison Ave, New York, NY', p_place: {lat: 40.7414, lng: -73.9876, label: 'New York office'}}},
  {name: 'São Paulo partner', properties: {p_region: 'opt_americas', p_kind: 'opt_partner', p_headcount: 20, p_address: 'Av. Paulista, São Paulo', p_place: {lat: -23.5614, lng: -46.6559, label: 'São Paulo partner'}}},
  // EMEA
  {name: 'London office', properties: {p_region: 'opt_emea', p_kind: 'opt_office', p_headcount: 70, p_address: '30 St Mary Axe, London', p_place: {lat: 51.5144, lng: -0.0803, label: 'London office'}}},
  {name: 'Berlin office', properties: {p_region: 'opt_emea', p_kind: 'opt_office', p_headcount: 48, p_address: 'Unter den Linden, Berlin', p_place: {lat: 52.5170, lng: 13.3889, label: 'Berlin office'}}},
  // Lisbon: address only, NO coords — the map's unplaced/geocode case.
  {name: 'Lisbon partner', properties: {p_region: 'opt_emea', p_kind: 'opt_partner', p_headcount: 12, p_address: 'Praça do Comércio, Lisbon, Portugal'}},
  // APAC
  {name: 'Singapore office', properties: {p_region: 'opt_apac', p_kind: 'opt_office', p_headcount: 60, p_address: 'Marina Bay, Singapore', p_place: {lat: 1.2834, lng: 103.8607, label: 'Singapore office'}}},
  {name: 'Tokyo office', properties: {p_region: 'opt_apac', p_kind: 'opt_office', p_headcount: 85, p_address: 'Chiyoda, Tokyo', p_place: {lat: 35.6814, lng: 139.7670, label: 'Tokyo office'}}},
  {name: 'Sydney partner', properties: {p_region: 'opt_apac', p_kind: 'opt_partner', p_headcount: 15, p_address: 'Circular Quay, Sydney', p_place: {lat: -33.8610, lng: 151.2100, label: 'Sydney partner'}}},
];

// ── 🎯 Product HQ ────────────────────────────────────────────────────────────
// Two databases wired together: Initiatives (the page you land on) and Tasks
// (a sub-page). A 1:n relation links them BOTH ways (forward `Tasks` column +
// reverse `Initiative` column), two rollups on Initiatives fold the linked
// tasks (% done + task count), and a `dependency` property chains the tasks —
// surfaced as arrows on the Tasks page's timeline view.

/** Initiatives: status + the forward 1:n relation to Tasks + two rollups over it. */
const productHqInitiativesSchema = (tasksDbId: string): DatabaseSchema => ({
  properties: [
    {
      id: 'p_status',
      name: 'Status',
      type: 'status',
      options: [
        {id: 'opt_next', label: 'Up next', color: 'gray', group: 'todo'},
        {id: 'opt_track', label: 'On track', color: 'blue', group: 'in_progress'},
        {id: 'opt_risk', label: 'At risk', color: 'red', group: 'in_progress'},
        {id: 'opt_shipped', label: 'Shipped', color: 'green', group: 'complete'},
      ],
    },
    // The forward side of the two-way link: one initiative → many tasks.
    {id: 'p_tasks', name: 'Tasks', type: 'relation', relationDatabaseId: tasksDbId, relationCardinality: '1:n', reversePropertyId: 'p_initiative'},
    // Rollups fold the linked tasks: how done, and how many.
    {id: 'p_progress', name: 'Progress', type: 'rollup', rollup: {relationPropertyId: 'p_tasks', targetPropertyId: 'p_done', function: 'percent_checked'}},
    {id: 'p_count', name: 'Task count', type: 'rollup', rollup: {relationPropertyId: 'p_tasks', targetPropertyId: TITLE_PROPERTY_ID, function: 'count'}},
  ],
  views: [
    // The table leads (relation chips + rollups in one glance); a board backs it.
    {id: 'v_table', name: 'Table', type: 'table', filters: [], sorts: []},
    {id: 'v_board', name: 'Board', type: 'board', filters: [], sorts: [], groupByPropertyId: 'p_status'},
  ],
});

/** Tasks: the reverse (single) side of the relation, a Done checkbox the
 *  rollup folds, a date range, and the dependency chain the timeline draws. */
const productHqTasksSchema = (initiativesDbId: string): DatabaseSchema => ({
  properties: [
    {id: 'p_initiative', name: 'Initiative', type: 'relation', relationDatabaseId: initiativesDbId, relationSingle: true, reversePropertyId: 'p_tasks'},
    {id: 'p_owner', name: 'Owner', type: 'text'},
    {id: 'p_done', name: 'Done', type: 'checkbox'},
    {id: 'p_when', name: 'When', type: 'date', dateRange: true},
    {id: 'p_blockedby', name: 'Blocked by', type: 'dependency'},
  ],
  views: [
    // Timeline first: bars from the `When` range, dependency arrows from
    // `Blocked by` (predecessor end → dependent start).
    {id: 'v_timeline', name: 'Timeline', type: 'timeline', filters: [], sorts: [], datePropertyId: 'p_when', dependencyPropertyId: 'p_blockedby'},
    {id: 'v_table', name: 'Table', type: 'table', filters: [], sorts: []},
  ],
});

/** Build the two databases, then seed rows across both so the relation, the
 *  rollups, and the dependency arrows all render non-empty out of the box. */
const createProductHq = async (client: DataClient, name: string, guidance: string = GUIDANCE.productHq): Promise<StoredPage> => {
  // Pre-minted ids let each schema reference the OTHER database with no
  // second-pass schema update (createDatabase honours a client-supplied id).
  const initiativesDbId = globalThis.crypto.randomUUID();
  const tasksDbId = globalThis.crypto.randomUUID();
  const tasksName = `${name} Tasks`;

  // The guidance callout leads the Initiatives host page; the Tasks sub-page
  // stays bare (it's reached from the guided page).
  const page = await client.savePage({name, data: guidanceSnapshot({id: 'hq-guide', text: guidance})});
  const tasksPage = await client.savePage({name: tasksName, data: emptySnapshot([]), parentId: page.id});
  await client.createDatabase({id: initiativesDbId, pageId: page.id, name, schema: productHqInitiativesSchema(tasksDbId)});
  await client.createDatabase({id: tasksDbId, pageId: tasksPage.id, name: tasksName, schema: productHqTasksSchema(initiativesDbId)});

  const seedRow = async (dbId: string, rowName: string, properties: Record<string, unknown>): Promise<string> =>
    (await client.createRow(dbId, {name: rowName, properties})).id;

  // Initiatives first (the tasks link back to them)…
  const revamp = await seedRow(initiativesDbId, 'Onboarding revamp', {p_status: 'opt_track'});
  const perf = await seedRow(initiativesDbId, 'Performance push', {p_status: 'opt_risk'});
  const billing = await seedRow(initiativesDbId, 'Billing v2', {p_status: 'opt_shipped'});

  // …then the tasks: linked 1:n, dated for the timeline, chained by `Blocked by`.
  const t1 = await seedRow(tasksDbId, 'Ship onboarding checklist', {p_initiative: [revamp], p_owner: 'Ada', p_done: true, p_when: {start: day(-10), end: day(-3)}});
  const t2 = await seedRow(tasksDbId, 'Guided first-run tour', {p_initiative: [revamp], p_owner: 'Lin', p_done: false, p_when: {start: day(-2), end: day(6)}, p_blockedby: [t1]});
  const t3 = await seedRow(tasksDbId, 'Profile the hot paths', {p_initiative: [perf], p_owner: 'Sam', p_done: false, p_when: {start: day(1), end: day(5)}});
  const t4 = await seedRow(tasksDbId, 'Cache the page list', {p_initiative: [perf], p_owner: 'Sam', p_done: false, p_when: {start: day(6), end: day(12)}, p_blockedby: [t3]});
  const t5 = await seedRow(tasksDbId, 'Migrate legacy invoices', {p_initiative: [billing], p_owner: 'Lin', p_done: true, p_when: {start: day(-20), end: day(-12)}});

  // Mirror the reverse side of the two-way link. Seeding writes both sides
  // explicitly — the live mirror only runs on relation-cell edits. (updateRow
  // replaces the whole properties bag, so re-send the status too.)
  await client.updateRow(initiativesDbId, revamp, {properties: {p_status: 'opt_track', p_tasks: [t1, t2]}});
  await client.updateRow(initiativesDbId, perf, {properties: {p_status: 'opt_risk', p_tasks: [t3, t4]}});
  await client.updateRow(initiativesDbId, billing, {properties: {p_status: 'opt_shipped', p_tasks: [t5]}});

  return page;
};

// ── 📊 Dashboard ─────────────────────────────────────────────────────────────
// A composite dashboard: a KPI row + DB-backed bar/pie/trend charts laid out in
// the 12-col column blocks, all reading LIVE from a sample "sales" database the
// template also seeds (a sub-page). The charts are ordinary in-doc `kitchart`
// blocks in DATABASE source mode (DASH-3) — their `dbId` is stamped at
// instantiation, when the sample database's id is minted. Unlike the database
// fixtures you land on a composed DOCUMENT, not a table/board.

/** The sample sales database the dashboard charts. One row = one deal, with a
 *  Region/Channel/Stage/Quarter to group by and Amount/Units to total. */
const SALES_SCHEMA: DatabaseSchema = {
  properties: [
    {
      id: 'p_region',
      name: 'Region',
      type: 'select',
      options: [
        {id: 'opt_north', label: 'North', color: 'blue'},
        {id: 'opt_south', label: 'South', color: 'green'},
        {id: 'opt_east', label: 'East', color: 'orange'},
        {id: 'opt_west', label: 'West', color: 'purple'},
      ],
    },
    {
      id: 'p_channel',
      name: 'Channel',
      type: 'select',
      options: [
        {id: 'opt_online', label: 'Online', color: 'blue'},
        {id: 'opt_retail', label: 'Retail', color: 'pink'},
        {id: 'opt_partner', label: 'Partner', color: 'yellow'},
      ],
    },
    {
      id: 'p_stage',
      name: 'Stage',
      type: 'status',
      options: [
        {id: 'opt_pipeline', label: 'Pipeline', color: 'gray', group: 'todo'},
        {id: 'opt_committed', label: 'Committed', color: 'blue', group: 'in_progress'},
        {id: 'opt_won', label: 'Won', color: 'green', group: 'complete'},
      ],
    },
    {
      id: 'p_quarter',
      name: 'Quarter',
      type: 'select',
      options: [
        {id: 'opt_q1', label: 'Q1', color: 'gray'},
        {id: 'opt_q2', label: 'Q2', color: 'gray'},
        {id: 'opt_q3', label: 'Q3', color: 'gray'},
        {id: 'opt_q4', label: 'Q4', color: 'gray'},
      ],
    },
    {id: 'p_amount', name: 'Amount', type: 'number', numberDisplay: 'number'},
    {id: 'p_units', name: 'Units', type: 'number'},
  ],
  views: [
    // The data page opens on the table; a bar view backs it (and exercises the
    // DB chart-view kit engine on the sample data itself).
    {id: 'v_table', name: 'Table', type: 'table', filters: [], sorts: []},
    {id: 'v_bar', name: 'By region', type: 'bar', filters: [], sorts: [], groupByPropertyId: 'p_region', aggregate: {type: 'sum', propertyId: 'p_amount'}},
  ],
};

const SALES_ROWS = [
  {name: 'Northwind renewal', properties: {p_region: 'opt_north', p_channel: 'opt_online', p_stage: 'opt_won', p_quarter: 'opt_q1', p_amount: 24000, p_units: 120}},
  {name: 'Acme retail order', properties: {p_region: 'opt_north', p_channel: 'opt_retail', p_stage: 'opt_committed', p_quarter: 'opt_q2', p_amount: 18000, p_units: 90}},
  {name: 'Globex expansion', properties: {p_region: 'opt_south', p_channel: 'opt_online', p_stage: 'opt_won', p_quarter: 'opt_q1', p_amount: 31000, p_units: 150}},
  {name: 'Initech pilot', properties: {p_region: 'opt_south', p_channel: 'opt_partner', p_stage: 'opt_pipeline', p_quarter: 'opt_q3', p_amount: 12000, p_units: 60}},
  {name: 'Umbrella upsell', properties: {p_region: 'opt_east', p_channel: 'opt_online', p_stage: 'opt_committed', p_quarter: 'opt_q2', p_amount: 27000, p_units: 130}},
  {name: 'Soylent reorder', properties: {p_region: 'opt_east', p_channel: 'opt_retail', p_stage: 'opt_won', p_quarter: 'opt_q4', p_amount: 22000, p_units: 110}},
  {name: 'Hooli trial', properties: {p_region: 'opt_west', p_channel: 'opt_partner', p_stage: 'opt_pipeline', p_quarter: 'opt_q3', p_amount: 9000, p_units: 45}},
  {name: 'Stark contract', properties: {p_region: 'opt_west', p_channel: 'opt_online', p_stage: 'opt_won', p_quarter: 'opt_q4', p_amount: 35000, p_units: 170}},
  {name: 'Wayne partnership', properties: {p_region: 'opt_north', p_channel: 'opt_partner', p_stage: 'opt_committed', p_quarter: 'opt_q2', p_amount: 15000, p_units: 70}},
  {name: 'Cyberdyne restock', properties: {p_region: 'opt_south', p_channel: 'opt_retail', p_stage: 'opt_won', p_quarter: 'opt_q1', p_amount: 20000, p_units: 100}},
  {name: 'Tyrell evaluation', properties: {p_region: 'opt_east', p_channel: 'opt_online', p_stage: 'opt_pipeline', p_quarter: 'opt_q3', p_amount: 14000, p_units: 68}},
  {name: 'Massive Dynamic order', properties: {p_region: 'opt_west', p_channel: 'opt_retail', p_stage: 'opt_committed', p_quarter: 'opt_q4', p_amount: 17000, p_units: 82}},
];

/** A database-bound `kitchart` block (DASH-3 source mode). `dbId` is stamped at
 *  instantiation; `count` needs no numeric property, so `aggProp` is optional. A
 *  one-line `description` keeps the edit view clean (no ghost "Add a description…"). */
const dashboardChart = (
  dbId: string,
  id: string,
  kind: string,
  title: string,
  description: string,
  groupBy: string,
  aggType: 'count' | 'sum',
  aggProp?: string,
  /** Cross-filter (DASH-7): bind the chart to a named input + a property so a
   *  top-of-dashboard control re-scopes it. Omitted → the chart is unfiltered. */
  filter?: {input: string; prop: string},
): object => ({
  id,
  type: 'kitchart',
  props: {
    kind,
    title,
    description,
    sourceMode: 'database',
    dbId,
    dbGroupBy: groupBy,
    dbAggType: aggType,
    ...(aggProp ? {dbAggProp: aggProp} : {}),
    ...(filter ? {dbFilterInput: filter.input, dbFilterProp: filter.prop} : {}),
  },
});

/** The dashboard document: a leading guidance callout, a KPI row across the top
 *  (three tiles in a 12-col columns block), then the bar+pie pair and a
 *  full-width quarterly trend — every chart bound to the seeded sales database. */
const dashboardBlocks = (dbId: string, guidance: string): object[] => {
  // The cross-filter (DASH-7): a Quarter control published as `quarter`. Every
  // chart below (except the quarterly trend, which IS the quarter axis) binds to
  // it on the Quarter property, so picking a quarter re-scopes the whole board.
  const QUARTER_FILTER = {input: 'quarter', prop: 'p_quarter'};
  const chart = (id: string, kind: string, title: string, description: string, groupBy: string, aggType: 'count' | 'sum', aggProp?: string, filter: {input: string; prop: string} | null = QUARTER_FILTER) =>
    dashboardChart(dbId, id, kind, title, description, groupBy, aggType, aggProp, filter ?? undefined);
  return [
    guidanceCallout('db-guide', guidance),
    // Cross-filter control: a dropdown that publishes `quarter`. "All quarters"
    // (value `all`) is the default and reads as inactive, so the board opens
    // showing the whole year; picking Q1–Q4 scopes every bound chart at once.
    {
      id: 'db-filter',
      type: 'dropdown',
      props: {
        name: 'quarter',
        label: 'Quarter',
        value: 'all',
        opts: [{label: 'All quarters', value: 'all'}, {label: 'Q1'}, {label: 'Q2'}, {label: 'Q3'}, {label: 'Q4'}],
      },
    },
    {id: 'db-h1', type: 'heading', text: [{t: 'This quarter at a glance'}], props: {level: 2}},
    // KPI row — three number tiles across the top (the DASH-5 `kpi` kind). Each
    // folds a grouped DB series to one grand total; the tile's title names it.
    // All three bind to the Quarter cross-filter (default `chart` filter).
    {
      id: 'db-kpis',
      type: 'columns',
      children: [
        {id: 'db-kc1', type: 'column', props: {span: 4}, children: [chart('db-k-rev', 'kpi', 'Total revenue (£)', 'Summed across every region', 'p_region', 'sum', 'p_amount')]},
        {id: 'db-kc2', type: 'column', props: {span: 4}, children: [chart('db-k-deals', 'kpi', 'Deals', 'Every row, across all stages', 'p_stage', 'count')]},
        {id: 'db-kc3', type: 'column', props: {span: 4}, children: [chart('db-k-units', 'kpi', 'Units sold', 'Summed across every channel', 'p_channel', 'sum', 'p_units')]},
      ],
    },
    {id: 'db-h2', type: 'heading', text: [{t: 'Breakdown'}], props: {level: 2}},
    // Bar + pie side by side in a 6/6 split — both scoped by the Quarter filter.
    {
      id: 'db-cols',
      type: 'columns',
      children: [
        {id: 'db-cl', type: 'column', props: {span: 6}, children: [chart('db-bar', 'bar', 'Revenue by region (£)', 'Amount summed per sales region', 'p_region', 'sum', 'p_amount')]},
        {id: 'db-cr', type: 'column', props: {span: 6}, children: [chart('db-pie', 'pie', 'Deals by channel', 'Share of deals won online, retail and via partners', 'p_channel', 'count')]},
      ],
    },
    // A full-width quarterly trend closes the dashboard. It is NOT bound to the
    // Quarter filter (it is already the quarter axis) — it stays full-year, giving
    // context while the tiles + breakdowns above slice to the chosen quarter.
    chart('db-line', 'line', 'Revenue by quarter (£)', 'Amount summed by quarter, Q1 → Q4', 'p_quarter', 'sum', 'p_amount', null),
    // Trailing pointer: how to ADD a chart (distinct from the lead callout, which
    // is about editing the data). The slash menu inserts a Chart, then its ⚙
    // Source toggle switches it to Database — there is no "/chart → Database".
    {id: 'db-note', type: 'callout', text: [{t: 'Want another cut of the data? Type /chart to insert one, then switch its Source to Database in the chart’s ⚙ settings and pick this database.'}], props: {variant: 'info'}},
  ];
};

/** Build the dashboard document, then seed the sample sales database it charts.
 *  The dashboard host page is saved FIRST (so its charts' `dbId` is the minted
 *  sample-db id), and the sample database lands on a sub-page. */
const createDashboard = async (client: DataClient, name: string, guidance: string = GUIDANCE.dashboard): Promise<StoredPage> => {
  const dataDbId = globalThis.crypto.randomUUID();
  const dataName = `${name} data`;
  const page = await client.savePage({
    name,
    data: {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: {blocks: dashboardBlocks(dataDbId, guidance)}},
  });
  const dataPage = await client.savePage({name: dataName, data: emptySnapshot([]), parentId: page.id});
  await client.createDatabase({id: dataDbId, pageId: dataPage.id, name: dataName, schema: SALES_SCHEMA});
  for (const row of SALES_ROWS) {
    let rowName: string | null = row.name;
    for (let attempt = 2; ; attempt += 1) {
      try {
        await client.createRow(dataDbId, {...row, name: rowName});
        break;
      } catch {
        if (attempt > 5) {
          await client.createRow(dataDbId, {...row, name: null});
          break;
        }
        rowName = `${row.name} ${attempt}`;
      }
    }
  }
  return page;
};

// ── The gallery ──────────────────────────────────────────────────────────────

/** Create a block-editor template page from a JSON block projection. */
const createBlockDocPage =
  (blocks: object[]) =>
    (client: DataClient, name: string): Promise<StoredPage> =>
      client.savePage({name, data: {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: {blocks}}});

/** Create a database template: host page + database + sample rows. Names are
 *  not unique, so a plain create always lands; the retry ladder below survives
 *  transient failures (untitled as a last resort). `guide` (id + canonical
 *  English text) puts the standardized guidance callout on the host page —
 *  where a database template's doc surface renders, above the view. */
const createDatabasePage =
  (schema: DatabaseSchema, rows: {name: string; properties: Record<string, unknown>}[], guide?: {id: string; text: string}) =>
    async (client: DataClient, name: string, guidance?: string): Promise<StoredPage> => {
      const page = await client.savePage({name, data: guidanceSnapshot(guide && {id: guide.id, text: guidance ?? guide.text})});
      const db = await client.createDatabase({pageId: page.id, name, schema});
      for (const row of rows) {
        let rowName: string | null = row.name;
        for (let attempt = 2; ; attempt += 1) {
          try {
            await client.createRow(db.id, {...row, name: rowName});
            break;
          } catch {
            if (attempt > 5) {
              await client.createRow(db.id, {...row, name: null});
              break;
            }
            rowName = `${row.name} ${attempt}`;
          }
        }
      }
      return page;
    };

/** A fresh copy of the sample document under its own gallery name. It already
 *  opens with its own intro paragraph (`sample-intro`), so — unlike the database
 *  fixtures — it carries no standardized guidance callout of its own (that would
 *  double-guide, stacking a near-duplicate lead above the intro). */
const createCompoundGrowth = (client: DataClient, name: string): Promise<StoredPage> => {
  const input = buildSampleDocument();
  return client.savePage({...input, name});
};

export const PAGE_TEMPLATES: PageTemplate[] = [
  {id: 'grocery-tracker', icon: '🛒', pageName: 'Grocery price tracker', tags: ['interactive', 'slides'], create: createBlockDocPage(GROCERY_BLOCKS)},
  {id: 'task-board', icon: '🗂️', pageName: 'Project task board', tags: ['database'], guidance: GUIDANCE.taskBoard, create: createDatabasePage(TASK_BOARD_SCHEMA, TASK_BOARD_ROWS, {id: 'tb-guide', text: GUIDANCE.taskBoard})},
  {id: 'reading-list', icon: '📚', pageName: 'Reading list', tags: ['database'], guidance: GUIDANCE.readingList, create: createDatabasePage(READING_SCHEMA, READING_ROWS, {id: 'rl-guide', text: GUIDANCE.readingList})},
  {id: 'project-intake', icon: '📋', pageName: 'Project intake', tags: ['interactive', 'slides'], create: createBlockDocPage(PROJECT_INTAKE_BLOCKS)},
  {id: 'savings-planner', icon: '💰', pageName: 'Savings & investing', tags: ['interactive', 'slides'], create: createBlockDocPage(SAVINGS_BLOCKS)},
  {id: 'roadmap', icon: '🗺️', pageName: 'Product roadmap', tags: ['database'], guidance: GUIDANCE.roadmap, create: createDatabasePage(ROADMAP_SCHEMA, ROADMAP_ROWS, {id: 'rm-guide', text: GUIDANCE.roadmap})},
  {id: 'field-map', icon: '📍', pageName: 'Field map', tags: ['database'], guidance: GUIDANCE.fieldMap, create: createDatabasePage(FIELD_MAP_SCHEMA, FIELD_MAP_ROWS, {id: 'fm-guide', text: GUIDANCE.fieldMap})},
  {id: 'pitch-deck', icon: '📽️', pageName: 'Pitch deck', tags: ['interactive', 'slides'], create: createBlockDocPage(PITCH_DECK_BLOCKS)},
  {id: 'team-status', icon: '🚦', pageName: 'Team status dashboard', tags: ['interactive'], create: createBlockDocPage(TEAM_STATUS_BLOCKS)},
  {id: 'product-hq', icon: '🎯', pageName: 'Product HQ', tags: ['database'], guidance: GUIDANCE.productHq, create: createProductHq},
  // A composite dashboard: KPI tiles + DB-backed charts over a seeded sales
  // database. Tagged `interactive` (you land on a document, not a table), so it
  // groups under Interactive documents; the description names its data backing.
  {id: 'dashboard', icon: '📊', pageName: 'Sales dashboard', tags: ['interactive'], guidance: GUIDANCE.dashboard, create: createDashboard},
  // The classic sample document, folded into the gallery. Unlike the Home
  // starter's open-or-create (which targets the canonical sample name and never
  // overwrites), the gallery card always mints a FRESH copy under its own
  // display name — the two entry points never race or shadow each other.
  {id: 'compound-growth', icon: '📈', pageName: 'Compound growth', tags: ['interactive'], create: createCompoundGrowth},
];

/** Courtesy numbering (names are not unique): a second instance becomes
 *  `name 2`, `name 3`… so repeated instantiations stay tellable-apart. */
async function availableName(client: DataClient, base: string): Promise<string> {
  const taken = new Set((await client.listPages()).map((p) => p.name).filter(Boolean) as string[]);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Instantiate a template: pick a distinct display name (courtesy numbering —
 * duplicates are allowed but unhelpful for ready-made pages) and build the page
 * through the client, retrying transient failures. `opts.guidance` localizes
 * the leading guidance callout of templates that carry one (the gallery passes
 * the user's locale text; absent, the canonical English default applies).
 */
export async function instantiateTemplate(client: DataClient, template: PageTemplate, opts?: {guidance?: string}): Promise<StoredPage> {
  let name = await availableName(client, template.pageName);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await template.create(client, name, opts?.guidance);
    } catch (err) {
      // A concurrent create can win the name between the check and the save;
      // step the suffix and retry a few times before giving up.
      if (attempt >= 4) throw err;
      name = await availableName(client, `${template.pageName}`);
      name = name === template.pageName ? `${template.pageName} 2` : name;
    }
  }
}
