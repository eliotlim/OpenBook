import {createHash} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {BackupScheduler} from './backups.ts';
import {PageStore} from './store.ts';

const ASSET_BYTES = 1024 * 1024;
const ASSET_COUNT = 128;
const outputDir = process.argv[2];
const now = '2026-08-11T00:00:00.000Z';
const pageId = '00000000-0000-4000-8000-000000000001';
const ids = Array.from({length: ASSET_COUNT}, (_, index) =>
  createHash('sha256').update(Buffer.alloc(ASSET_BYTES, index)).digest('hex'));

const pageRow = {
  id: pageId,
  name: 'heap-cap-streaming-library',
  data: {editorjs: {blocks: []}, values: [], names: [], assetIds: ids},
  database_id: null,
  parent_id: null,
  properties: {},
  deleted_at: null,
  position: 0,
  created_at: now,
  updated_at: now,
  hosted_database_id: null,
};

const db = {
  async query(text, params = []) {
    if (text.includes("settings WHERE key = 'instance'")) {
      return [{value: {instanceId: '00000000-0000-4000-8000-000000000002'}}];
    }
    if (text === 'SELECT value FROM settings WHERE key = $1') return [];
    if (text.includes('FROM pages p LEFT JOIN databases') && text.includes('p.deleted_at IS NULL')) return [pageRow];
    if (text.includes('FROM databases')) return [];
    if (text === 'SELECT id FROM assets') return ids.map((id) => ({id}));
    if (text.includes('SELECT id, mime, size, bytes FROM assets WHERE id = $1')) {
      const id = params[0];
      const index = ids.indexOf(id);
      if (index < 0) return [];
      return [{id, mime: 'application/octet-stream', size: ASSET_BYTES, bytes: Buffer.alloc(ASSET_BYTES, index)}];
    }
    if (text.includes('SELECT id, visibility, agent_edits FROM pages')) {
      return [{id: pageId, visibility: 'inherit', agent_edits: 'inherit'}];
    }
    if (text.includes('FROM page_acl')) return [];
    throw new Error(`unexpected synthetic backup query: ${text}`);
  },
  async begin(fn) {
    return fn(this);
  },
  async close() {},
};

const store = new PageStore(db);
const config = {
  enabled: true,
  dir: null,
  cadences: {daily: true, weekly: false, monthly: false, yearly: false},
  keep: {daily: 1, weekly: 1, monthly: 1, yearly: 1},
  lastRun: {},
};
store.getBackupConfig = async () => config;
store.updateBackupConfig = async (patch) => Object.assign(config, patch);

const scheduler = new BackupScheduler(store, {defaultDir: outputDir, now: () => Date.parse(now)});
const result = await scheduler.runNow('daily');
const fileBytes = (await stat(join(outputDir, 'daily', result.file))).size;
process.stdout.write(JSON.stringify({rawBytes: ASSET_BYTES * ASSET_COUNT, fileBytes}));
