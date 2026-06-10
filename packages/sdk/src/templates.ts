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
  id: 'tasks' | 'meeting-notes' | 'roadmap' | 'reading-list' | 'weekly-planner';
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
    {id: 'v_timeline', name: 'Timeline', type: 'timeline', filters: [], sorts: [], datePropertyId: 'p_when'},
    {id: 'v_board', name: 'Board', type: 'board', filters: [], sorts: [], groupByPropertyId: 'p_stage'},
    {id: 'v_table', name: 'Table', type: 'table', filters: [], sorts: []},
  ],
};

const ROADMAP_ROWS = [
  {name: 'Self-serve onboarding', properties: {p_stage: 'opt_build', p_area: 'opt_growth', p_when: {start: day(-7), end: day(14)}}},
  {name: 'Realtime collaboration', properties: {p_stage: 'opt_idea', p_area: 'opt_core', p_when: {start: day(21), end: day(60)}}},
  {name: 'Usage analytics dashboard', properties: {p_stage: 'opt_idea', p_area: 'opt_growth', p_when: {start: day(10), end: day(30)}}},
  {name: 'Single sign-on', properties: {p_stage: 'opt_shipped', p_area: 'opt_infra', p_when: {start: day(-30), end: day(-10)}}},
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

// ── The gallery ──────────────────────────────────────────────────────────────

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
  {id: 'reading-list', icon: '📚', pageName: 'Reading list', create: createDatabasePage(READING_SCHEMA, READING_ROWS)},
  {id: 'meeting-notes', icon: '📝', pageName: 'Meeting notes', create: createDocPage(MEETING_NOTES_BLOCKS)},
  {id: 'weekly-planner', icon: '🗓️', pageName: 'Weekly planner', create: createDocPage(WEEKLY_PLANNER_BLOCKS)},
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
