import type {APIRequestContext} from '@playwright/test';
import {test, expect} from './fixtures';
import {SERVER, emptySnapshot} from './seed';

// Per-test workspace isolation: fixed page names below are safe on reruns.
test.use({freshWorkspace: true});

// IA-6: the breadcrumb is a navigation instrument — every crumb with siblings
// or subpages carries a jump menu, and deep chains collapse their middle into
// an "…" menu instead of overflowing the bar.
//
// Locator note: crumb buttons and menu items include the page-icon glyph
// (📄) in their accessible name, so page names are matched via getByText /
// name-regexes; only the aria-labelled chevron and "…" triggers full-match.

async function seedPage(request: APIRequestContext, name: string, parentId: string | null = null): Promise<string> {
  const res = await request.post(`${SERVER}/api/pages`, {data: {name, data: emptySnapshot, parentId}});
  return ((await res.json()) as {id: string}).id;
}

test('breadcrumb: crumb menus jump to siblings and subpages', {tag: ['@shell']}, async ({page, request}) => {
  const root = await seedPage(request, 'Crumb Root');
  const alpha = await seedPage(request, 'Crumb Alpha', root);
  const beta = await seedPage(request, 'Crumb Beta', root);
  await seedPage(request, 'Crumb Leaf', alpha);

  await page.goto(`/?page=${alpha}`);
  const crumbs = page.getByRole('navigation', {name: 'Breadcrumb'});
  await expect(crumbs.getByText('Crumb Alpha', {exact: true})).toBeVisible();

  // The current crumb's chevron opens a menu of its siblings and subpages.
  await crumbs.getByRole('button', {name: 'Siblings and subpages of "Crumb Alpha"'}).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByText('Siblings', {exact: true})).toBeVisible();
  await expect(menu.getByText('Subpages', {exact: true})).toBeVisible();
  await expect(menu.getByRole('menuitem', {name: /Crumb Leaf/})).toBeVisible();

  // Esc closes without navigating.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`page=${alpha}`));

  // Lateral jump: a sibling item navigates the primary pane.
  await crumbs.getByRole('button', {name: 'Siblings and subpages of "Crumb Alpha"'}).click();
  await page.getByRole('menu').getByRole('menuitem', {name: /Crumb Beta/}).click();
  await expect(page).toHaveURL(new RegExp(`page=${beta}`));
  await expect(crumbs.getByText('Crumb Beta', {exact: true})).toBeVisible();

  // Downward jump from an ANCESTOR crumb: the root's menu lists its subpages
  // ("Crumb Alpha" appears there only — it is not a sibling of the root).
  await crumbs.getByText('Crumb Root', {exact: true}).hover(); // ancestor chevrons reveal on crumb hover
  await crumbs.getByRole('button', {name: 'Siblings and subpages of "Crumb Root"'}).click();
  await page.getByRole('menu').getByRole('menuitem', {name: /Crumb Alpha/}).click();
  await expect(page).toHaveURL(new RegExp(`page=${alpha}`));
});

test('breadcrumb: deep chains collapse the middle into an ellipsis menu', {tag: ['@shell']}, async ({page, request}) => {
  const names = ['Bc Depth 1', 'Bc Depth 2', 'Bc Depth 3', 'Bc Depth 4', 'Bc Depth 5'];
  const ids: string[] = [];
  for (const [i, name] of names.entries()) ids.push(await seedPage(request, name, i === 0 ? null : ids[i - 1]));

  await page.goto(`/?page=${ids[4]}`);
  const crumbs = page.getByRole('navigation', {name: 'Breadcrumb'});

  // Five levels render as `Depth 1 / … / Depth 4 / Depth 5`.
  await expect(crumbs.getByText('Bc Depth 1', {exact: true})).toBeVisible();
  await expect(crumbs.getByText('Bc Depth 4', {exact: true})).toBeVisible();
  await expect(crumbs.getByText('Bc Depth 5', {exact: true})).toBeVisible();
  await expect(crumbs.getByText('Bc Depth 2', {exact: true})).toHaveCount(0);
  await expect(crumbs.getByText('Bc Depth 3', {exact: true})).toHaveCount(0);

  // The "…" menu lists the elided middle, in path order, and navigates.
  await crumbs.getByRole('button', {name: 'Show hidden pages'}).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', {name: /Bc Depth 2/})).toBeVisible();
  await menu.getByRole('menuitem', {name: /Bc Depth 3/}).click();
  await expect(page).toHaveURL(new RegExp(`page=${ids[2]}`));

  // A three-level chain fits — no collapse.
  await expect(crumbs.getByText('Bc Depth 2', {exact: true})).toBeVisible();
  await expect(crumbs.getByRole('button', {name: 'Show hidden pages'})).toHaveCount(0);
});
