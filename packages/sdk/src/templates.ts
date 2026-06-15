import type {DataClient} from './client';
import type {PageSnapshot, StoredPage} from './types';
import type {DatabaseSchema} from './database';

/**
 * The built-in **template gallery**: ready-made pages instantiated client-side
 * through the normal data APIs (no server involvement, same as the sample
 * document). Two shapes:
 *
 *  - **Block-doc artifacts** (the five showcases) ship a native block-editor
 *    JSON projection in `blockdoc: {blocks}`. They lean on the whole editor:
 *    reactive inputs feeding *collapsed* live-code, status lights, info/link/
 *    tooltip cards, charts, progress bars, multi-column layouts, callouts, and
 *    `divider`/`notes` blocks so every page doubles as a slide deck with
 *    speaker notes (see blockeditor/present.ts).
 *  - **Databases** (roadmap, field map) ship a schema, views, and sample rows;
 *    they back the swimlane and map e2e fixtures.
 *
 * Ids are stable so the gallery, its i18n keys, and the e2e suite can reference
 * a template without depending on display strings.
 */

export interface PageTemplate {
  /** Stable identifier (i18n keys + tests hang off this). */
  id: 'grocery-tracker' | 'task-board' | 'reading-list' | 'project-intake' | 'savings-planner' | 'roadmap' | 'field-map';
  /** Emoji shown on the gallery card and applied to the created page. */
  icon: string;
  /** Canonical (English) page name; suffixed when it collides. */
  pageName: string;
  /** Creates the page (and database, if any) and returns the stored page. */
  create: (client: DataClient, name: string) => Promise<StoredPage>;
}

const emptySnapshot = (blocks: object[]): PageSnapshot => ({
  editorjs: {blocks},
  values: [],
  names: [],
});

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
    // Board first → the page opens as a kanban grouped by status; a table backs it.
    {id: 'v_board', name: 'Board', type: 'board', filters: [], sorts: [], groupByPropertyId: 'p_status'},
    {id: 'v_table', name: 'Table', type: 'table', filters: [], sorts: []},
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
  {name: 'The Design of Everyday Things', properties: {p_shelf: 'opt_reading', p_author: 'Don Norman', p_rating: 4}},
  {name: 'Project Hail Mary', properties: {p_shelf: 'opt_reading', p_author: 'Andy Weir', p_rating: 5}},
  {name: 'Thinking, Fast and Slow', properties: {p_shelf: 'opt_toread', p_author: 'Daniel Kahneman'}},
  {name: 'Designing Data-Intensive Applications', properties: {p_shelf: 'opt_toread', p_author: 'Martin Kleppmann'}},
  {name: 'The Pragmatic Programmer', properties: {p_shelf: 'opt_done', p_author: 'Hunt & Thomas', p_rating: 5}},
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

// ── The gallery ──────────────────────────────────────────────────────────────

/** Create a block-editor template page from a JSON block projection. */
const createBlockDocPage =
  (blocks: object[]) =>
    (client: DataClient, name: string): Promise<StoredPage> =>
      client.savePage({name, data: {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: {blocks}}});

/** Create a database template: host page + database + sample rows. Row pages
 *  share the workspace-unique name space, so re-instantiating a template would
 *  409 on its sample rows — suffix each on collision (untitled as a last resort). */
const createDatabasePage =
  (schema: DatabaseSchema, rows: {name: string; properties: Record<string, unknown>}[]) =>
    async (client: DataClient, name: string): Promise<StoredPage> => {
      const page = await client.savePage({name, data: emptySnapshot([])});
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

export const PAGE_TEMPLATES: PageTemplate[] = [
  {id: 'grocery-tracker', icon: '🛒', pageName: 'Grocery price tracker', create: createBlockDocPage(GROCERY_BLOCKS)},
  {id: 'task-board', icon: '🗂️', pageName: 'Project task board', create: createDatabasePage(TASK_BOARD_SCHEMA, TASK_BOARD_ROWS)},
  {id: 'reading-list', icon: '📚', pageName: 'Reading list', create: createDatabasePage(READING_SCHEMA, READING_ROWS)},
  {id: 'project-intake', icon: '📋', pageName: 'Project intake', create: createBlockDocPage(PROJECT_INTAKE_BLOCKS)},
  {id: 'savings-planner', icon: '💰', pageName: 'Savings & investing', create: createBlockDocPage(SAVINGS_BLOCKS)},
  {id: 'roadmap', icon: '🗺️', pageName: 'Product roadmap', create: createDatabasePage(ROADMAP_SCHEMA, ROADMAP_ROWS)},
  {id: 'field-map', icon: '📍', pageName: 'Field map', create: createDatabasePage(FIELD_MAP_SCHEMA, FIELD_MAP_ROWS)},
];

/** Page names are unique among live pages — pick `name`, `name 2`, `name 3`… */
async function availableName(client: DataClient, base: string): Promise<string> {
  const taken = new Set((await client.listPages()).map((p) => p.name).filter(Boolean) as string[]);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Instantiate a template: resolve a free page name (retrying past races on the
 * unique-name constraint) and build the page through the client.
 */
export async function instantiateTemplate(client: DataClient, template: PageTemplate): Promise<StoredPage> {
  let name = await availableName(client, template.pageName);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await template.create(client, name);
    } catch (err) {
      // A concurrent create can win the name between the check and the save;
      // step the suffix and retry a few times before giving up.
      if (attempt >= 4) throw err;
      name = await availableName(client, `${template.pageName}`);
      name = name === template.pageName ? `${template.pageName} 2` : name;
    }
  }
}
