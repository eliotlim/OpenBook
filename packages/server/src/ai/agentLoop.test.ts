/**
 * Agent run-loop hardening (AGENT-4): the loop must be resilient to tool
 * failures and its effort dial must give multi-tool tasks enough room.
 *
 *  - A tool that THROWS must surface a clear, recoverable error as the
 *    `tool_result` the model sees — and the run must CONTINUE (feed the error
 *    back, take the next step) rather than aborting.
 *  - A tool that returns nothing is normalised to an explicit note (no
 *    ambiguous empty result).
 *  - The schema/description fixes that carry behaviour (the set_db_cell error
 *    pointer) resolve to the right guidance.
 *  - `maxSteps` per effort is raised (bounded) so dependent tool chains fit.
 *
 * We drive the runner directly with a scripted JSON-protocol engine (call one
 * tool, then answer), mirroring the harness in aiGating.test.ts.
 */

import {rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {guestPrincipal, type PluginAgentTool, type Principal} from '@book.dev/sdk';
import {PgliteDb} from '../db';
import {PageStore} from '../store';
import {AiService} from './service';
import {AgentRunner, type AgentEvent} from './agent';
import type {AiEngine} from './providers';
import {effortProfile} from './effort';

const ISS = 'https://account.book.pub';
let store: PageStore;
let db: PgliteDb;
let dir: string;
let seq = 0;

const snapshot = () => ({editorjs: {blocks: []}, values: [], names: []});

const principal = (sub: string): Principal => ({
  kind: 'user',
  subject: `${ISS}#${sub}`,
  issuer: ISS,
  name: sub,
  verifiedVia: 'jws',
});

/** A 2-turn JSON-protocol engine: call `tool(args)` once, then answer "ok". */
const scriptEngine = (tool: string, args: Record<string, unknown>): AiEngine => ({
  kind: 'mock',
  async ensureReady() {
    /* always ready */
  },
  async generate(prompt, opts) {
    const out = prompt.includes('TOOL RESULT') ? JSON.stringify({final: 'ok'}) : JSON.stringify({tool, args});
    opts.onToken(out);
    return out;
  },
  async dispose() {
    /* nothing to release */
  },
});

/** An AiService whose AGENT engine is scripted; the real `search` is inherited. */
class ScriptedAi extends AiService {
  scripted: AiEngine = scriptEngine('list_pages', {});
  async engineForRequest(): Promise<{engine: AiEngine; transient: boolean}> {
    return {engine: this.scripted, transient: false};
  }
}

/** Run ONE scripted tool call and capture EVERY event the run emits. */
const runCapture = async (
  who: Principal | undefined,
  tool: string,
  args: Record<string, unknown>,
  opts: {pluginTools?: PluginAgentTool[]} = {},
): Promise<AgentEvent[]> => {
  const ai = new ScriptedAi(db, join(dir, 'models'));
  ai.scripted = scriptEngine(tool, args);
  const runner = new AgentRunner(ai, store, {principal: who, thinking: false, ...opts});
  const events: AgentEvent[] = [];
  await runner.run([{role: 'user', content: 'go'}], (ev) => {
    events.push(ev);
  });
  return events;
};

const resultOf = (events: AgentEvent[], name: string): string => {
  const ev = events.find((e) => e.type === 'tool_result' && e.name === name);
  return ev && ev.type === 'tool_result' ? ev.result : '';
};
const finalOf = (events: AgentEvent[]): string | undefined => {
  const ev = events.find((e) => e.type === 'final');
  return ev && ev.type === 'final' ? ev.text : undefined;
};

beforeEach(async () => {
  seq += 1;
  dir = join(tmpdir(), `ob-agentloop-${process.pid}-${seq}`);
  rmSync(dir, {recursive: true, force: true});
  db = await PgliteDb.create(dir);
  store = new PageStore(db);
  await store.migrate();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await store.close();
  rmSync(dir, {recursive: true, force: true});
});

describe('run loop: a throwing tool is fed back as a recoverable error, run continues', () => {
  it('a tool that throws surfaces a clear tool_result error AND the run reaches its final answer', async () => {
    // Simulate a failure INSIDE the tool (e.g. the store blowing up mid-call).
    vi.spyOn(store, 'listPagesFor').mockRejectedValue(new Error('db exploded'));

    const events = await runCapture(principal('owner'), 'list_pages', {});

    // The model saw a definite, named, recoverable error — not a swallowed blank.
    const result = resultOf(events, 'list_pages');
    expect(result).toContain('list_pages');
    expect(result.toLowerCase()).toContain('failed');
    expect(result).toContain('db exploded');

    // Crucially: the throw did NOT abort the run — it fed the error back and the
    // loop took the next step, reaching the final answer.
    expect(finalOf(events)).toBe('ok');

    // A recoverable tool error is NOT a run-ending `error` event.
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('the tool + tool_result events are emitted in order (the UI still sees the failed call)', async () => {
    vi.spyOn(store, 'listPagesFor').mockRejectedValue(new Error('nope'));
    const events = await runCapture(principal('owner'), 'list_pages', {});
    const kinds = events.map((e) => e.type);
    expect(kinds.indexOf('tool')).toBeLessThan(kinds.indexOf('tool_result'));
    expect(kinds).toContain('final');
  });
});

describe('run loop: an empty tool result is normalised to an explicit note', () => {
  it('a plugin prompt tool with no instructions returns a definite "no output" note', async () => {
    // A `prompt` plugin tool with empty instructions returns '' from its run —
    // the loop must not hand the model an ambiguous blank tool_result.
    const pluginTools: PluginAgentTool[] = [{name: 'blank_tool', description: 'contributes nothing', action: 'prompt', instructions: ''}];
    const events = await runCapture(principal('owner'), 'blank_tool', {}, {pluginTools});
    expect(resultOf(events, 'blank_tool')).toContain('returned no output');
    expect(finalOf(events)).toBe('ok');
  });
});

describe('run loop: an unknown tool name is reported without aborting', () => {
  it('calling a tool that does not exist yields a recoverable "unknown tool" result and a final answer', async () => {
    const events = await runCapture(principal('owner'), 'no_such_tool', {});
    // No tool/tool_result frames for a non-existent tool, but the run still finishes
    // (the model is told, via the transcript, which tools exist).
    expect(finalOf(events)).toBe('ok');
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});

describe('schema fix: set_db_cell points at describe_database for a bad property id', () => {
  let hostPage: string;
  let rowId: string;

  beforeEach(async () => {
    // Unclaimed instance ⇒ the guest has blanket access (legacy single-user path).
    hostPage = (await store.upsertPage({name: `db-host-${seq}`, data: snapshot()})).id;
    await store.createDatabase({pageId: hostPage, name: 'DB', schema: {properties: [], views: []}});
    const dbId = (await store.getDatabaseByPage(hostPage))!.id;
    rowId = (await store.createRow(dbId, {name: 'row', properties: {}})).id;
  });

  it('the error names describe_database (the real source of column ids), not the stale list_db_views/get_db_row', async () => {
    const events = await runCapture(guestPrincipal(), 'set_db_cell', {pageId: hostPage, rowId, propertyId: 'nope', value: 'x'});
    const result = resultOf(events, 'set_db_cell');
    expect(result).toContain('describe_database');
    expect(result).not.toContain('list_db_views');
  });
});

describe('effort: maxSteps per effort is raised with a bounded ceiling', () => {
  it('low/med/high are 6/12/24 — monotonic and finite', () => {
    expect(effortProfile('low').maxSteps).toBe(6);
    expect(effortProfile('med').maxSteps).toBe(12);
    expect(effortProfile('high').maxSteps).toBe(24);
    expect(effortProfile('low').maxSteps).toBeLessThan(effortProfile('med').maxSteps);
    expect(effortProfile('med').maxSteps).toBeLessThan(effortProfile('high').maxSteps);
    // A step is a paid model turn — keep the ceiling bounded.
    expect(effortProfile('high').maxSteps).toBeLessThanOrEqual(24);
  });

  it('an unknown/undefined effort still resolves to the default profile (no crash)', () => {
    expect(effortProfile(undefined).maxSteps).toBe(12); // DEFAULT_EFFORT = med
  });
});
