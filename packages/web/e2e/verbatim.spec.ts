import {test, expect} from '@chromatic-com/playwright';
import {newPage} from './seed';

// Verbatim inputs must not autocorrect/autocapitalize/spellcheck — they'd mangle
// commands and code.
test('command palette input disables autocorrect', async ({page}) => {
  await page.goto('/');
  await page.getByRole('button', {name: 'Search'}).click();
  const input = page.getByPlaceholder(/Search pages or run a command/);
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute('spellcheck', 'false');
  await expect(input).toHaveAttribute('autocorrect', 'off');
  await expect(input).toHaveAttribute('autocapitalize', 'off');
});

test('code block textarea disables autocorrect', async ({page, request}) => {
  const id = await newPage(request, 'Verbatim Code', {
    editorjs: {blocks: [{type: 'code', data: {code: 'const x = 1'}}]},
    values: [],
    names: [],
  });
  await page.goto(`/?page=${id}`);

  // Scoped to the editor: the page title is also a textarea now.
  const ta = page.locator('.codex-editor').locator('.ce-code__textarea, textarea').first();
  await expect(ta).toBeVisible();
  await expect(ta).toHaveAttribute('spellcheck', 'false');
  await expect(ta).toHaveAttribute('autocorrect', 'off');
});
