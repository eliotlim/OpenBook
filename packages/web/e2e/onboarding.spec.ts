import {test, expect} from './fixtures';

// First-run experience: a truly empty workspace lands on Home with the guided
// start (welcome, starter actions) instead of auto-creating a blank page, and
// a brand-new page teaches its own entry point (the "/" placeholder shows on
// the sole empty paragraph without waiting for focus).
test.use({freshWorkspace: true});

test('first run: lands on Home with the guided start', {tag: ['@shell', '@p1']}, async ({page}) => {
  await page.goto('/');
  await expect(page.locator('[data-home-screen]')).toBeVisible();

  // The guided-start card replaces the plain quick-actions widget.
  const getStarted = page.locator('[data-home-widget="get-started"]');
  await expect(getStarted).toBeVisible();
  await expect(getStarted.getByRole('button', {name: 'New page'})).toBeVisible();
  await expect(getStarted.getByRole('button', {name: 'Start from a template'})).toBeVisible();
  await expect(getStarted.getByRole('button', {name: 'Explore the sample document'})).toBeVisible();

  // No page was silently created behind the user's back.
  await expect(page.getByRole('treeitem')).toHaveCount(0);
});

test('first run: New page opens an editor that advertises "/"', {tag: ['@shell']}, async ({page}) => {
  await page.goto('/');
  const getStarted = page.locator('[data-home-widget="get-started"]');
  await expect(getStarted).toBeVisible();

  await getStarted.getByRole('button', {name: 'New page'}).click();

  // The new page's sole empty paragraph shows the slash hint unfocused.
  const firstBlock = page.locator('[data-block-text][data-placeholder*="commands"]');
  await expect(firstBlock).toBeVisible();
});

test('first run: the sample document seeds and opens', {tag: ['@shell']}, async ({page}) => {
  await page.goto('/');
  const getStarted = page.locator('[data-home-widget="get-started"]');
  await expect(getStarted).toBeVisible();

  await getStarted.getByRole('button', {name: 'Explore the sample document'}).click();

  // The sample page opens as the primary document (a real page id, not Home).
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await expect
    .poll(() => {
      const id = new URL(page.url()).searchParams.get('page');
      return id && id !== 'home' ? id : null;
    })
    .toBeTruthy();
});
