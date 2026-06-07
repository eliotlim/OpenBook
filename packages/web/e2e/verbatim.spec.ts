import {test, expect} from '@chromatic-com/playwright';

const SERVER = 'http://127.0.0.1:4319';

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
  const res = await request.post(`${SERVER}/api/pages`, {
    data: {
      name: 'Verbatim Code',
      data: {editorjs: {blocks: [{type: 'code', data: {code: 'const x = 1'}}]}, values: [], names: []},
    },
  });
  const {id} = (await res.json()) as {id: string};
  await page.goto(`/?page=${id}`);

  const ta = page.locator('.ce-code__textarea, textarea').first();
  await expect(ta).toBeVisible();
  await expect(ta).toHaveAttribute('spellcheck', 'false');
  await expect(ta).toHaveAttribute('autocorrect', 'off');
});
