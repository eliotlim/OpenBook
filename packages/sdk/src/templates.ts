import type {DataClient} from './client';
import type {PageSnapshot, StoredPage} from './types';
import type {DatabaseSchema} from './database';

/**
 * The built-in **template gallery**: a handful of ready-made pages — documents
 * with pre-arranged blocks, and databases with a schema, views, and a few
 * sample rows — instantiated client-side through the normal data APIs (no
 * server involvement, same as the sample document). The UI shows them in a
 * gallery dialog; ids are stable so the gallery, its i18n keys, and the e2e
 * suite can reference a template without depending on display strings.
 */

export interface PageTemplate {
  /** Stable identifier (i18n keys + tests hang off this). */
  id: 'tasks' | 'meeting-notes' | 'roadmap' | 'reading-list' | 'weekly-planner' | 'interactive-dashboard' | 'compound-growth' | 'loan-calculator' | 'pricing-estimator' | 'field-map' | 'intake-form';
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

// ── Task tracker ─────────────────────────────────────────────────────────────

const TASKS_SCHEMA: DatabaseSchema = {
  properties: [
    {
      id: 'p_status',
      name: 'Status',
      type: 'status',
      options: [
        {id: 'opt_todo', label: 'Todo', color: 'gray', group: 'todo'},
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
    {id: 'p_due', name: 'Due', type: 'date'},
    {id: 'p_effort', name: 'Effort', type: 'number', numberDisplay: 'bar', numberTarget: 8},
  ],
  views: [
    {id: 'v_table', name: 'Table', type: 'table', filters: [], sorts: []},
    {id: 'v_board', name: 'Board', type: 'board', filters: [], sorts: [], groupByPropertyId: 'p_status'},
  ],
};

const TASKS_ROWS = [
  {name: 'Outline the launch announcement', properties: {p_status: 'opt_doing', p_priority: 'opt_high', p_due: day(2), p_effort: 3}},
  {name: 'Review onboarding feedback', properties: {p_status: 'opt_todo', p_priority: 'opt_med', p_due: day(5), p_effort: 5}},
  {name: 'Fix the signup form validation', properties: {p_status: 'opt_todo', p_priority: 'opt_high', p_due: day(1), p_effort: 2}},
  {name: 'Archive last sprint’s board', properties: {p_status: 'opt_done', p_priority: 'opt_low', p_effort: 1}},
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

// ── Reading list ─────────────────────────────────────────────────────────────

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
  {name: 'Thinking, Fast and Slow', properties: {p_shelf: 'opt_toread', p_author: 'Daniel Kahneman'}},
  {name: 'The Pragmatic Programmer', properties: {p_shelf: 'opt_done', p_author: 'Hunt & Thomas', p_rating: 5}},
];

// ── Document templates ───────────────────────────────────────────────────────

const MEETING_NOTES_BLOCKS = [
  {id: 'mn-toc', type: 'toc', data: {}},
  {id: 'mn-agenda-h', type: 'header', data: {text: 'Agenda', level: 2}},
  {
    id: 'mn-agenda',
    type: 'checklist',
    data: {items: [
      {text: 'Review last week’s action items', checked: false},
      {text: 'Project status round-up', checked: false},
      {text: 'Open questions', checked: false},
    ]},
  },
  {id: 'mn-notes-h', type: 'header', data: {text: 'Notes', level: 2}},
  {id: 'mn-notes', type: 'paragraph', data: {text: 'Capture discussion points here…'}},
  {id: 'mn-actions-h', type: 'header', data: {text: 'Action items', level: 2}},
  {
    id: 'mn-actions',
    type: 'checklist',
    data: {items: [{text: 'Add an owner and a due date to each action', checked: false}]},
  },
  {id: 'mn-div', type: 'divider', data: {style: 'line'}},
  {
    id: 'mn-tip',
    type: 'callout',
    data: {variant: 'info', text: 'Tip: link people and pages inline by typing <b>@</b>.'},
  },
];

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const WEEKLY_PLANNER_BLOCKS = [
  {
    id: 'wp-focus',
    type: 'callout',
    data: {variant: 'success', text: 'This week’s focus: write it down — one sentence keeps the week honest.'},
  },
  ...WEEKDAYS.flatMap((dayName) => [
    {id: `wp-${dayName.toLowerCase()}-h`, type: 'header', data: {text: dayName, level: 3}},
    {
      id: `wp-${dayName.toLowerCase()}-list`,
      type: 'checklist',
      data: {items: [{text: '', checked: false}]},
    },
  ]),
  {id: 'wp-div', type: 'divider', data: {style: 'labeled', label: 'weekend'}},
  {id: 'wp-notes', type: 'paragraph', data: {text: 'Loose notes, wins, and anything to carry into next week.'}},
];


// Compound growth: three sliders feed a live-code projection (the classic
// sample, rebuilt on the unified system) — invested vs grown, plotted live.
const COMPOUND_GROWTH_BLOCKS = [
  {id: 'tpl-cg-h', type: 'heading', text: [{t: 'Compound growth'}], props: {level: 2}},
  {id: 'tpl-cg-p', type: 'paragraph', text: [{t: 'Drag the sliders — the projection recomputes live. Open the code block to see (and change) the maths.'}]},
  {id: 'tpl-cg-m', type: 'slider', props: {name: 'monthly', value: 300, min: 50, max: 2000}},
  {id: 'tpl-cg-y', type: 'slider', props: {name: 'years', value: 20, min: 1, max: 40}},
  {id: 'tpl-cg-r', type: 'slider', props: {name: 'rate', value: 7, min: 1, max: 12}},
  {
    id: 'tpl-cg-code',
    type: 'code',
    text: [
      {
        t: 'const r = rate / 100 / 12;\nconst months = years * 12;\nlet bal = 0;\nconst invested = [], grown = [];\nfor (let m = 1; m <= months; m++) {\n  bal = (bal + monthly) * (1 + r);\n  if (m % 12 === 0) { invested.push(monthly * m); grown.push(Math.round(bal)); }\n}\nreturn {series: [{name: \'Invested\', data: invested}, {name: \'With growth\', data: grown}]};',
      },
    ],
    props: {live: true, name: 'projection', language: 'js'},
  },
  {id: 'tpl-cg-chart', type: 'kitchart', props: {kind: 'area', title: 'Balance by year', source: 'projection'}},
  {
    id: 'tpl-cg-final',
    type: 'code',
    text: [{t: '\'After \' + years + \' years: \' + projection.series[1].data[projection.series[1].data.length - 1].toLocaleString()'}],
    props: {live: true, name: 'summary', language: 'js'},
  },
];

// Loan repayment: amount/rate/term feed a payment + balance schedule; a
// budget stepper drives the affordability status light (chained live code).
const LOAN_BLOCKS = [
  {id: 'tpl-loan-h', type: 'heading', text: [{t: 'Loan repayment'}], props: {level: 2}},
  {id: 'tpl-loan-a', type: 'slider', props: {name: 'amount', value: 400000, min: 50000, max: 1000000}},
  {id: 'tpl-loan-r', type: 'slider', props: {name: 'rate', value: 5, min: 1, max: 10}},
  {id: 'tpl-loan-y', type: 'slider', props: {name: 'years', value: 25, min: 5, max: 35}},
  {id: 'tpl-loan-b', type: 'number', props: {name: 'budget', label: 'Monthly budget', value: 2500, min: 0, step: 100}},
  {
    id: 'tpl-loan-pay',
    type: 'code',
    text: [{t: 'const r = rate / 100 / 12;\nconst n = years * 12;\nreturn Math.round((amount * r) / (1 - Math.pow(1 + r, -n)));'}],
    props: {live: true, name: 'payment', language: 'js'},
  },
  {
    id: 'tpl-loan-sched',
    type: 'code',
    text: [
      {t: 'const r = rate / 100 / 12;\nlet bal = amount;\nconst out = [];\nfor (let y = 1; y <= years; y++) {\n  for (let m = 0; m < 12; m++) bal = bal * (1 + r) - payment;\n  out.push(Math.max(0, Math.round(bal)));\n}\nreturn out;'},
    ],
    props: {live: true, name: 'balance', language: 'js'},
  },
  {id: 'tpl-loan-chart', type: 'kitchart', props: {kind: 'area', title: 'Remaining balance', source: 'balance'}},
  {id: 'tpl-loan-status', type: 'statuslight', props: {label: 'Within budget', source: 'payment <= budget', okAt: 1, warnAt: 0}},
];

// Pricing estimator: a stepper, a radio, and a toggle feed one price
// computation; a bar chart breaks the total down.
const PRICING_BLOCKS = [
  {id: 'tpl-price-h', type: 'heading', text: [{t: 'Pricing estimator'}], props: {level: 2}},
  {id: 'tpl-price-s', type: 'number', props: {name: 'seats', label: 'Seats', value: 25, min: 1, max: 500, step: 1}},
  {id: 'tpl-price-plan', type: 'radio', props: {name: 'plan', label: 'Plan', options: 'Basic, Pro, Scale', value: 'Pro'}},
  {id: 'tpl-price-an', type: 'toggle', props: {name: 'annual', label: 'Annual billing', value: true}},
  {
    id: 'tpl-price-code',
    type: 'code',
    text: [
      {t: 'const unit = {Basic: 6, Pro: 12, Scale: 20}[plan];\nconst volume = seats > 100 ? 0.8 : seats > 25 ? 0.9 : 1;\nconst billing = annual ? 0.85 : 1;\nconst list = seats * unit;\nconst total = Math.round(list * volume * billing);\nreturn {list, total, saving: list - total};'},
    ],
    props: {live: true, name: 'price', language: 'js'},
  },
  {id: 'tpl-price-chart', type: 'kitchart', props: {kind: 'bar', title: 'Monthly cost', labels: 'List, You pay, Saving', source: '[price.list, price.total, price.saving]'}},
  {
    id: 'tpl-price-sum',
    type: 'code',
    text: [{t: 'price.total.toLocaleString() + \' / month for \' + seats + \' seats on \' + plan'}],
    props: {live: true, name: 'quote', language: 'js'},
  },
];

// A live artifact built from the block editor's kit: inputs feed a shared
// reactive scope; the charts, status light, and formula compute over it.
// Plain JSON projection with stable ids — the block editor seeds a CRDT doc
// from it on first open.
const DASHBOARD_BLOCKS = [
  {id: 'tpl-dash-h', type: 'heading', text: [{t: 'Project pulse'}], props: {level: 2}},
  {id: 'tpl-dash-p', type: 'paragraph', text: [{t: 'Steer the inputs — everything below computes live. Open ⚙ on any block to rewire it.'}]},
  {id: 'tpl-dash-done', type: 'number', props: {name: 'done', label: 'Tasks done', value: 7, min: 0, max: 20, step: 1}},
  {id: 'tpl-dash-risk', type: 'slider', props: {name: 'risk', value: 35, min: 0, max: 100}},
  {
    id: 'tpl-dash-phase',
    type: 'choicecards',
    props: {
      name: 'phase',
      value: 'beta',
      opts: [
        {label: 'Alpha', value: 'alpha', icon: '🧪', color: 'purple'},
        {label: 'Beta', value: 'beta', icon: '🚧', color: 'orange'},
        {label: 'GA', value: 'ga', icon: '🚀', color: 'green'},
      ],
    },
  },
  {id: 'tpl-dash-progress', type: 'progressbar', props: {label: 'Sprint progress', source: 'done / 20', max: 1, format: 'percent'}},
  {id: 'tpl-dash-donut', type: 'kitchart', props: {kind: 'donut', title: 'Progress', source: '{Done: done, Left: 20 - done}'}},
  {id: 'tpl-dash-line', type: 'kitchart', props: {kind: 'line', title: 'Risk trend', source: '[risk*0.6, risk*0.8, risk, risk*1.15, risk*0.9]'}},
  {id: 'tpl-dash-status', type: 'statuslight', props: {label: 'Ship readiness', source: 'done - risk/10', okAt: 4, warnAt: 1}},
  {id: 'tpl-dash-btn', type: 'actionbutton', props: {btnlabel: 'Mark one done', action: 'increment', target: 'done', amount: 1}},
  {id: 'tpl-dash-rem', type: 'formula', props: {source: '20 - done'}},
];

// A guided intake wizard built from the June-2026 kit: a gated accordion holds
// the stages, each stage a coherent set of the new inputs (choice cards with
// icon covers, a searchable select, a free-entry tag field, long + rich text),
// and a progress bar bound to the accordion's auto-computed completion
// (`intake.ratio`). Gating locks later stages until earlier ones are filled, so
// it reads as a real onboarding form rather than a control dump. Stable ids and
// option values keep it queryable as a Playwright fixture.
const INTAKE_FORM_BLOCKS = [
  {id: 'tpl-intake-h', type: 'heading', text: [{t: 'New project intake'}], props: {level: 2}},
  {id: 'tpl-intake-p', type: 'paragraph', text: [{t: 'Tell us about the work. Each stage unlocks the next once it’s filled in — the bar tracks how far along you are.'}]},
  {id: 'tpl-intake-progress', type: 'progressbar', props: {label: 'Completed', source: 'intake.ratio', max: 1, format: 'percent'}},
  {
    id: 'tpl-intake-acc',
    type: 'accordion',
    props: {name: 'intake', gated: true},
    children: [
      {
        id: 'tpl-intake-basics',
        type: 'accordionsection',
        props: {label: 'Basics'},
        children: [
          {id: 'tpl-intake-basics-p', type: 'paragraph', text: [{t: 'What kind of project is this, and what’s the one-line goal?'}]},
          {
            id: 'tpl-intake-type',
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
          {id: 'tpl-intake-summary', type: 'longtext', props: {name: 'summary', value: '', placeholder: 'One sentence: what does done look like?'}},
        ],
      },
      {
        id: 'tpl-intake-scope',
        type: 'accordionsection',
        props: {label: 'Scope', collapsed: true},
        children: [
          {id: 'tpl-intake-scope-p', type: 'paragraph', text: [{t: 'Where does it land, and who needs to be in the loop?'}]},
          {
            id: 'tpl-intake-platform',
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
          {
            id: 'tpl-intake-teams',
            type: 'tagfield',
            props: {name: 'teams', selected: [], freeEntry: true, opts: [{label: 'Design'}, {label: 'Engineering'}, {label: 'Product'}, {label: 'Data'}, {label: 'Support'}]},
          },
        ],
      },
      {
        id: 'tpl-intake-details',
        type: 'accordionsection',
        props: {label: 'Details', collapsed: true},
        children: [
          {id: 'tpl-intake-details-p', type: 'paragraph', text: [{t: 'Spell out the requirements and confirm the pre-flight checks.'}]},
          {id: 'tpl-intake-req', type: 'richtext', props: {name: 'requirements', runs: [], placeholder: 'Requirements, constraints, links…'}},
          {id: 'tpl-intake-check-spec', type: 'todo', text: [{t: 'Spec reviewed with the lead'}], props: {checked: false}},
          {id: 'tpl-intake-check-est', type: 'todo', text: [{t: 'Rough estimate agreed'}], props: {checked: false}},
        ],
      },
    ],
  },
  {id: 'tpl-intake-status', type: 'statuslight', props: {label: 'Ready to submit', source: 'intake.complete', okAt: 1, warnAt: 1}},
];

// ── The gallery ──────────────────────────────────────────────────────────────

/** Create a block-editor template page from a JSON block projection. */
const createBlockDocPage =
  (blocks: object[]) =>
    (client: DataClient, name: string): Promise<StoredPage> =>
      client.savePage({name, data: {editorjs: {blocks: []}, values: [], names: [], editor: 'blocks', blockdoc: {blocks}}});

/** Create a document-only template page. */
const createDocPage =
  (blocks: object[]) =>
    (client: DataClient, name: string): Promise<StoredPage> =>
      client.savePage({name, data: emptySnapshot(blocks)});

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
  {id: 'tasks', icon: '✅', pageName: 'Task tracker', create: createDatabasePage(TASKS_SCHEMA, TASKS_ROWS)},
  {id: 'roadmap', icon: '🗺️', pageName: 'Product roadmap', create: createDatabasePage(ROADMAP_SCHEMA, ROADMAP_ROWS)},
  {id: 'field-map', icon: '📍', pageName: 'Field map', create: createDatabasePage(FIELD_MAP_SCHEMA, FIELD_MAP_ROWS)},
  {id: 'reading-list', icon: '📚', pageName: 'Reading list', create: createDatabasePage(READING_SCHEMA, READING_ROWS)},
  {id: 'meeting-notes', icon: '📝', pageName: 'Meeting notes', create: createDocPage(MEETING_NOTES_BLOCKS)},
  {id: 'weekly-planner', icon: '🗓️', pageName: 'Weekly planner', create: createDocPage(WEEKLY_PLANNER_BLOCKS)},
  {id: 'interactive-dashboard', icon: '📊', pageName: 'Project pulse', create: createBlockDocPage(DASHBOARD_BLOCKS)},
  {id: 'intake-form', icon: '📋', pageName: 'New project intake', create: createBlockDocPage(INTAKE_FORM_BLOCKS)},
  {id: 'compound-growth', icon: '📈', pageName: 'Compound growth', create: createBlockDocPage(COMPOUND_GROWTH_BLOCKS)},
  {id: 'loan-calculator', icon: '🏦', pageName: 'Loan repayment', create: createBlockDocPage(LOAN_BLOCKS)},
  {id: 'pricing-estimator', icon: '🧮', pageName: 'Pricing estimator', create: createBlockDocPage(PRICING_BLOCKS)},
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
