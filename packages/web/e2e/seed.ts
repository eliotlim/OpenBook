import type {APIRequestContext, Page} from '@playwright/test';

/**
 * This worker's OpenBook data server. Every Playwright worker runs its own
 * (spawned by the `dataServer` fixture in fixtures.ts) so spec files can run
 * in parallel with fully disjoint workspaces; the port must mirror the
 * fixture's `WORKER_BASE_PORT + workerIndex` (workerIndex is unique per
 * worker instance, surviving worker restarts after a failure).
 */
export const SERVER = `http://127.0.0.1:${4400 + Number(process.env.TEST_WORKER_INDEX ?? 0)}`;

export const emptySnapshot = {editorjs: {blocks: []}, values: [], names: []};

/**
 * Free workspace-unique names before a test claims them.
 *
 * Page names are unique among live pages — and rows are pages, so row titles
 * share the same space. Specs that seed or type fixed names pass on a fresh
 * server (CI) but 409 on reruns against a long-lived dev server: API seeds
 * come back without an id (`/?page=undefined` → the editor never mounts) and
 * UI renames silently revert. Trashing a page frees its name, so this finds
 * any live page/row holding one of `names` (via the whole-space export, which
 * lists rows too) and trashes it.
 */
export async function reclaimNames(request: APIRequestContext, ...names: string[]): Promise<void> {
  const bundle = (await (await request.get(`${SERVER}/api/export`)).json()) as {
    pages?: {id: string; name: string | null}[];
  };
  const wanted = new Set(names);
  for (const p of bundle.pages ?? []) {
    if (p.name && wanted.has(p.name)) await request.delete(`${SERVER}/api/pages/${p.id}`);
  }
}

/** Create a page with a stable name, reclaiming the name first (see above). */
export async function newPage(
  request: APIRequestContext,
  name: string,
  data: Record<string, unknown> = emptySnapshot,
): Promise<string> {
  await reclaimNames(request, name);
  const res = await request.post(`${SERVER}/api/pages`, {data: {name, data}});
  return ((await res.json()) as {id: string}).id;
}

/**
 * Pin a test to the classic EditorJS editor. The CRDT block editor is the
 * default; specs that cover the classic editor (still fully supported, and
 * the renderer for un-migrated documents) opt out via the persisted
 * preference before the app boots. Call before the first `page.goto`.
 */
export async function useClassicEditor(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('openbook.preferences', JSON.stringify({general: {blockEditor: false}}));
  });
}
