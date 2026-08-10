import {test, expect} from './fixtures';
import {SERVER} from './seed';
import type {APIRequestContext, Page} from '@playwright/test';

/**
 * AGED-6 — the agent-edits POLICY MATRIX, end to end.
 *
 * The resolved mode for an agent write is `resolveAgentEdits(pagePolicy,
 * instanceMode)`: a page's explicit `suggest`/`direct` always wins; `inherit`
 * falls back to the instance-wide default; and an unset instance default is the
 * safe `suggest`. That gives a 2×3 grid — {instance: suggest|direct} × {page:
 * inherit|suggest|direct} — six cells, each resolving to one effective mode:
 *
 *   instance   page       → effective
 *   suggest    inherit    → suggest
 *   direct     inherit    → direct
 *   suggest    suggest    → suggest
 *   suggest    direct     → direct   (page override beats instance)
 *   direct     suggest    → suggest  (page override beats instance)
 *   direct     direct     → direct
 *
 * We exercise every cell through BOTH agent write vectors:
 *   1. a REAL remote MCP write over the `/api/mcp` JSON-RPC transport (a
 *      PAT-looped `append_to_page`), where the server is the authority — a
 *      suggest-mode write lands as a reviewable suggestion, a direct-mode write
 *      mutates the page; and
 *   2. the BUILT-IN AI write (the mock engine's `append_to_page` → a persisted
 *      suggestion → the AgentPanel routing it through the resolved policy on the
 *      client, because the AI writes under the user's own session and the server
 *      cannot tell it from a human).
 *
 * In every cell the assertion is the same shape: was the write APPLIED directly
 * or CREATED as a suggestion?  The two vectors must agree, cell for cell.
 */

type Mode = 'suggest' | 'direct';
type PagePolicy = 'inherit' | 'suggest' | 'direct';

interface Cell {
  instance: Mode;
  page: PagePolicy;
  effective: Mode;
}

const CELLS: Cell[] = [
  {instance: 'suggest', page: 'inherit', effective: 'suggest'},
  {instance: 'direct', page: 'inherit', effective: 'direct'},
  {instance: 'suggest', page: 'suggest', effective: 'suggest'},
  {instance: 'suggest', page: 'direct', effective: 'direct'},
  {instance: 'direct', page: 'suggest', effective: 'suggest'},
  {instance: 'direct', page: 'direct', effective: 'direct'},
];

// ── Server helpers (loopback owner over the worker's data server) ────────────────

/** Set the instance-wide agent-edits default. */
async function setInstanceMode(request: APIRequestContext, mode: Mode): Promise<void> {
  const res = await request.put(`${SERVER}/api/instance`, {data: {agentEdits: mode}});
  expect(res.ok(), `set instance mode ${mode}`).toBeTruthy();
}

/** Pin (or leave inheriting) a page's per-page agent-edits policy. */
async function setPagePolicy(request: APIRequestContext, id: string, policy: PagePolicy): Promise<void> {
  const res = await request.put(`${SERVER}/api/pages/${id}/agent-edits`, {data: {agentEdits: policy}});
  expect(res.ok(), `set page policy ${policy}`).toBeTruthy();
}

/** Create a page carrying one text block (so it renders + gives the AI ambient context). */
async function makePage(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {
      name,
      data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'Seed line for AGED6.'}}]}, values: [], names: []},
    },
  });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as {id: string}).id;
}

/** Enable the (dark, default-off) agent API and mint a write PAT. Returns the
 *  plaintext bearer and the token id (for the provenance assertion). */
async function enableAgentApiAndMint(request: APIRequestContext): Promise<{pat: string; tokenId: string}> {
  const on = await request.put(`${SERVER}/api/agent-tokens`, {data: {enabled: true}});
  expect(on.ok(), 'enable agent API').toBeTruthy();
  const mint = await request.post(`${SERVER}/api/agent-tokens`, {data: {name: 'aged6-matrix', scope: 'write'}});
  expect(mint.status(), 'mint write PAT').toBe(201);
  const body = (await mint.json()) as {token: string; meta: {id: string}};
  return {pat: body.token, tokenId: body.meta.id};
}

/** One JSON-RPC `tools/call` over the real `/api/mcp` streamable-HTTP transport
 *  (stateless JSON mode), returning the concatenated text of the tool result. */
async function mcpToolText(
  request: APIRequestContext,
  pat: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = await request.post(`${SERVER}/api/mcp`, {
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    data: {jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: {name, arguments: args}},
  });
  expect(res.ok(), `MCP ${name} HTTP status`).toBeTruthy();
  const json = (await res.json()) as {result?: {content?: Array<{type: string; text?: string}>}};
  return (json.result?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
}

const MCP_MARKER = 'AGED6 MCP MARKER';

// ── Vector 1: real MCP writes over /api/mcp ──────────────────────────────────────

test.describe('AGED-6 policy matrix — real MCP writes', () => {
  test.use({freshWorkspace: true});

  // A remote MCP write resolves its mode through the PAT-looped policy client over
  // `GET /api/pages/:id/agent-edits`, which a PAT may read. AGED-6 made that route
  // return the SERVER-RESOLVED `effective` mode alongside the raw policy, so ALL SIX
  // cells — including `instance=direct` on an `inherit` page — now resolve correctly
  // WITHOUT the privileged `GET /api/instance` read the AGENT-6 scope-gate denies to a
  // PAT. The whole matrix is exercised here; the `inherit`-under-instance-`direct`
  // cell has its own focused assertion below.
  test('every cell applies directly or queues a suggestion per the resolved mode', async ({request, ownerRequest}) => {
    const {pat} = await enableAgentApiAndMint(request);

    for (const cell of CELLS) {
      await setInstanceMode(ownerRequest, cell.instance);
      const id = await makePage(request, `MCP ${cell.instance}/${cell.page}`);
      await setPagePolicy(request, id, cell.page);

      const label = `instance=${cell.instance} page=${cell.page} → ${cell.effective}`;
      const reply = await mcpToolText(request, pat, 'append_to_page', {pageId: id, content: MCP_MARKER});
      const readBack = await mcpToolText(request, pat, 'read_page', {pageId: id});

      if (cell.effective === 'direct') {
        expect(reply, `${label}: applied directly`).toContain('Appended directly');
        expect(readBack, `${label}: marker landed in the page`).toContain(MCP_MARKER);
      } else {
        expect(reply, `${label}: queued for review`).toContain('Suggested for review');
        expect(readBack, `${label}: page unchanged`).not.toContain(MCP_MARKER);
      }
    }
  });

  // AGED-6 CLOSED THIS GAP. The instance-wide `direct` default now governs a remote
  // MCP write to an `inherit` page. The MCP client learns the mode from the
  // SERVER-RESOLVED `effective` field on `GET /api/pages/:id/agent-edits` (PAT-readable),
  // so it no longer needs the privileged `GET /api/instance` read the AGENT-6 scope-gate
  // denies — and the setting governs remote PATs on `inherit` pages, backstopped by the
  // AGED-2 server write-gate.
  test('an inherit page honours the instance direct default over remote MCP', async ({request, ownerRequest}) => {
    const {pat} = await enableAgentApiAndMint(request);
    await setInstanceMode(ownerRequest, 'direct');
    const id = await makePage(request, 'MCP direct/inherit');
    await setPagePolicy(request, id, 'inherit');

    const reply = await mcpToolText(request, pat, 'append_to_page', {pageId: id, content: MCP_MARKER});
    expect(reply).toContain('Appended directly');
    const readBack = await mcpToolText(request, pat, 'read_page', {pageId: id});
    expect(readBack).toContain(MCP_MARKER);
  });

  test('provenance: a direct MCP write records the agent token as the author in the edit log', async ({request, ownerRequest}) => {
    const {pat, tokenId} = await enableAgentApiAndMint(request);
    await setInstanceMode(ownerRequest, 'direct');
    const id = await makePage(request, 'MCP provenance');
    // Pin the page to `direct` so the write applies directly over remote MCP (an
    // inherit page under this instance=direct default would resolve direct too since
    // AGED-6 — pinning keeps this provenance check independent of that resolution).
    await setPagePolicy(request, id, 'direct');

    const reply = await mcpToolText(request, pat, 'append_to_page', {pageId: id, content: MCP_MARKER});
    expect(reply).toContain('Appended directly');

    const edits = (await (await request.get(`${SERVER}/api/pages/${id}/edits`)).json()) as Array<{
      kind: string;
      authorName: string;
      verifiedVia: string;
      assertionKid: string | null;
    }>;
    // The write that landed the marker was authored by the PAT: verifiedVia 'pat',
    // an "(agent)" display name, and the minted token id in the assertion — never
    // silently attributed to the human owner.
    const agentEdit = edits.find((e) => e.verifiedVia === 'pat');
    expect(agentEdit, 'an edit-log row attributed to the agent PAT').toBeTruthy();
    expect(agentEdit!.authorName).toContain('(agent)');
    expect(agentEdit!.assertionKid).toBe(tokenId);
  });
});

// ── Vector 2: the built-in AI write, routed on the client ────────────────────────

/** Open the assistant side panel (mock engine) over the primary page. */
async function openAssistant(page: Page): Promise<ReturnType<Page['locator']>> {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('Ask the assistant');
  await page.keyboard.press('Enter');
  const panel = page.locator('[data-agent-panel]');
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('AGED-6 policy matrix — built-in AI writes', () => {
  test.use({freshWorkspace: true});

  test.beforeEach(async ({ownerRequest}) => {
    const res = await ownerRequest.put(`${SERVER}/api/ai/config`, {data: {provider: 'mock'}});
    expect(res.ok()).toBeTruthy();
  });

  test.afterAll(async ({ownerRequest}) => {
    await ownerRequest.put(`${SERVER}/api/ai/config`, {data: {provider: 'off'}});
  });

  for (const cell of CELLS) {
    test(`instance=${cell.instance}, page=${cell.page} → ${cell.effective}`, async ({page, request, ownerRequest}) => {
      await setInstanceMode(ownerRequest, cell.instance);
      const id = await makePage(request, `AI ${cell.instance}/${cell.page}`);
      await setPagePolicy(request, id, cell.page);

      await page.goto(`/?page=${id}`);
      await expect(page.locator('.obe-root')).toBeVisible();

      const panel = await openAssistant(page);
      await panel.locator('[data-agent-input]').fill('append via agent');
      await panel.locator('[data-agent-send]').click();

      if (cell.effective === 'direct') {
        // Routed direct: applied at once (its shadow review row dropped) and the
        // marker lands in the live editor.
        await expect(panel.locator('[data-agent-applied]')).toBeVisible();
        await expect(panel.locator('[data-agent-suggestions]')).toHaveCount(0);
        await expect(page.locator('.obe-text', {hasText: 'AGED6 AI DIRECT MARKER'})).toBeVisible();
      } else {
        // Routed suggest: the review card shows and the page is untouched.
        await expect(panel.locator('[data-agent-suggestions]')).toBeVisible();
        await expect(panel.locator('[data-agent-applied]')).toHaveCount(0);
        await expect(page.locator('.obe-text', {hasText: 'AGED6 AI DIRECT MARKER'})).toHaveCount(0);
      }
    });
  }
});
