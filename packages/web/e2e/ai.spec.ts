import {test, expect} from './fixtures';
import {SERVER} from './seed';

// The optional local-AI subsystem, driven end-to-end against the server's
// deterministic mock engine (no model download, instant responses). Config
// persists server-side, so each test sets what it needs and the suite
// resets to 'off' at the end.


const setProvider = async (request: import('@playwright/test').APIRequestContext, provider: string): Promise<void> => {
  const res = await request.put(`${SERVER}/api/ai/config`, {data: {provider}});
  expect(res.ok()).toBeTruthy();
};

test.afterAll(async ({request}) => {
  await setProvider(request, 'off');
});

test('settings: AI tab shows providers and engine status', async ({page, request}) => {
  await setProvider(request, 'off');
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('button', {name: 'AI', exact: true}).click();

  await expect(page.getByText('Built-in (llama.cpp)')).toBeVisible();
  await expect(page.getByText('MLX (Apple Silicon)')).toBeVisible();
  await expect(page.getByText('Local server (OpenAI-compatible)')).toBeVisible();
  await expect(page.getByText('Claude (Anthropic API)')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Rebuild index'})).toBeVisible();
  await page.keyboard.press('Escape');
});

test('settings: every provider is configurable at once + the radio picks the default', async ({page, request}) => {
  await setProvider(request, 'off');
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('button', {name: 'AI', exact: true}).click();

  // All providers' connection fields are shown together — Claude's API key, the
  // OpenAI/MLX model fields, and llama's download button — no selection needed.
  await expect(page.getByText('Default engine')).toBeVisible();
  await expect(page.getByPlaceholder('sk-ant-…')).toBeVisible();
  await expect(page.getByPlaceholder('claude-sonnet-4-6')).toBeVisible();
  await expect(page.getByPlaceholder('qwen2.5:1.5b')).toBeVisible();
  await expect(page.getByRole('button', {name: /Download recommended model/})).toBeVisible();

  // Configure Claude's key without changing the default (stays off → no
  // readiness network call); it persists under providers.claude.
  await page.getByPlaceholder('sk-ant-…').fill('sk-ant-test-key');
  await page.getByPlaceholder('sk-ant-…').blur();
  await page.waitForTimeout(300);
  const status = await (await request.get(`${SERVER}/api/ai/status`)).json();
  expect(status.config.providers?.claude?.apiKey).toBe('sk-ant-test-key');
  expect(status.config.provider).toBe('off');
  await page.keyboard.press('Escape');
});

test('AI search: palette command opens the dialog; results navigate', async ({page, request}) => {
  await setProvider(request, 'mock');
  const name = `AI Search Note ${Date.now()}`;
  const created = await request.post(`${SERVER}/api/pages`, {
    data: {
      name,
      data: {
        editorjs: {blocks: [{type: 'paragraph', data: {text: 'The migration checklist covers database backups and rollback plans.'}}]},
        values: [],
        names: [],
      },
    },
  });
  const {id} = (await created.json()) as {id: string};

  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('Search notes with AI');
  await page.keyboard.press('Enter');

  const input = page.getByPlaceholder('What are you looking for?');
  await expect(input).toBeVisible();
  await input.fill('migration rollback');
  await expect(page.locator('[data-ai-result]').first()).toContainText(name);
  await expect(page.locator('[data-ai-result]').first()).toContainText('rollback');

  await page.keyboard.press('Enter'); // pick the top result
  await expect(page).toHaveURL(new RegExp(id));
});

test('editor: Break into tasks and Continue writing run through the engine', async ({page, request}) => {
  await setProvider(request, 'mock');
  const created = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: `AI Editor ${Date.now()}`,
      data: {editorjs: {blocks: [{type: 'paragraph', data: {text: 'Ship the next release'}}]}, values: [], names: []},
    },
  });
  const {id} = (await created.json()) as {id: string};
  await page.goto(`/?page=${id}&editor=next`);
  await expect(page.locator('.obe-root')).toBeVisible();

  // Break into tasks → todo blocks from the (mock) engine.
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.obe-text')][0] as HTMLElement;
    el.focus();
    const sel = getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.press('Enter');
  await page.keyboard.type('/tasks');
  await expect(page.locator('.obe-slash-item', {hasText: 'Break into tasks'})).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.obe-todo .obe-text').first()).toHaveText('Outline the goal');
  await expect(page.locator('.obe-todo')).toHaveCount(3);

  // Continue writing → streamed completion lands in the block.
  await page.evaluate(() => {
    const texts = [...document.querySelectorAll('.obe-text')];
    const el = texts[texts.length - 1] as HTMLElement;
    el.focus();
    const sel = getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.press('Enter');
  await page.keyboard.type('/continue');
  await expect(page.locator('.obe-slash-item', {hasText: 'Continue writing'})).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByText('This continues the document with a mock completion.')).toBeVisible();
});

test('assistant panel: ask a question, watch the tool run, get a grounded answer', async ({page, request}) => {
  await setProvider(request, 'mock');
  const name = `Agent Note ${Date.now()}`;
  await request.post(`${SERVER}/api/pages`, {
    data: {
      name,
      data: {
        editorjs: {blocks: [{type: 'paragraph', data: {text: 'The sprint retrospective surfaced three deployment blockers.'}}]},
        values: [],
        names: [],
      },
    },
  });

  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Search pages or run a command/).fill('Ask the assistant');
  await page.keyboard.press('Enter');

  const panel = page.locator('[data-agent-panel]');
  await expect(panel).toBeVisible();
  const input = panel.locator('[data-agent-input]');
  await expect(input).toBeFocused();

  // The drawer carries per-conversation provider + model pickers (alongside
  // effort), defaulting to the configured engine. (The Select forwards only
  // aria-label, not data-*, so target the provider/effort pickers by label.)
  await expect(panel.getByLabel('Provider for this conversation')).toBeVisible();
  await expect(panel.locator('[data-agent-model]')).toBeVisible();
  await expect(panel.getByLabel('Effort')).toBeVisible();

  // Starter suggestions fill the input (without sending).
  await expect(panel.locator('[data-agent-suggestion]')).toHaveCount(3);
  await panel.locator('[data-agent-suggestion]').first().click();
  await expect(input).toHaveValue('What pages do I have?');

  await input.fill('sprint retrospective blockers');
  await panel.locator('[data-agent-send]').click();

  // The scripted mock agent searches first, then answers from the hits.
  await expect(panel.locator('[data-agent-item="user"]')).toHaveText('sprint retrospective blockers');
  await expect(panel.locator('[data-agent-tool="search_notes"]')).toBeVisible();
  await expect(panel.locator('[data-agent-item="assistant"]')).toContainText(/found \d+ relevant/);

  // The finished tool chip expands to reveal what the tool returned.
  await panel.locator('[data-agent-tool="search_notes"]').click();
  await expect(panel.locator('[data-agent-tool-result]')).toContainText(name);

  // New conversation clears the thread; closing the side pane hides the panel.
  await panel.getByRole('button', {name: 'New conversation'}).click();
  await expect(panel.locator('[data-agent-item]')).toHaveCount(0);
  await page.getByRole('button', {name: 'Hide split pane'}).click();
  await expect(panel).toHaveCount(0);
});

test('with AI off, the slash menu hides AI actions but search stays lexical', async ({page, request}) => {
  await setProvider(request, 'off');
  const search = await request.post(`${SERVER}/api/ai/search`, {data: {query: 'migration rollback'}});
  const body = (await search.json()) as {mode: string; results: unknown[]};
  expect(body.mode).toBe('lexical');
  expect(body.results.length).toBeGreaterThan(0);

  await page.goto('/editor-lab');
  await expect(page.locator('.obe-text').first()).toBeVisible();
  await page.locator('.obe-text').nth(2).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await expect(page.locator('.obe-slash')).toBeVisible();
  await expect(page.locator('.obe-slash-item', {hasText: 'Continue writing'})).toHaveCount(0);
});
