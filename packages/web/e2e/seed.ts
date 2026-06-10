import type {APIRequestContext} from '@playwright/test';

/** The OpenBook data server (Playwright boots it on :4319 / dev reuses it). */
export const SERVER = 'http://127.0.0.1:4319';

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
