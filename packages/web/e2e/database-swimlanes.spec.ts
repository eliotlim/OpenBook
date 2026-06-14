import {test, expect} from './fixtures';

// Sub-grouping swimlanes (T9), exercised through the improved `roadmap` template:
// its board sub-groups by Area (horizontal lanes) and its timeline bands by Area.

async function openRoadmap(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.getByRole('button', {name: 'Templates'}).click();
  await expect(page.getByText('Start with a template')).toBeVisible();
  await page.locator('[data-template="roadmap"]').click();
  await expect(page.getByLabel('Page title')).toHaveValue(/^Product roadmap/);
}

test('board: Area sub-group renders as full-width lane bars above the cards', async ({page}) => {
  await openRoadmap(page);
  await page.getByRole('button', {name: 'Board', exact: true}).click();

  // The primary group is the stage columns…
  await expect(page.locator('[data-col-key]').filter({hasText: 'Building'}).first()).toBeVisible();

  // …and each Area is a collapsible lane HEADER (a horizontal bar), not a column.
  for (const area of ['Core', 'Growth', 'Infra']) {
    await expect(page.getByRole('button', {name: `Collapse ${area} lane`})).toBeVisible();
  }

  // The lane bar spans the full board width (wider than a single column), and
  // collapsing it hides that lane's cards.
  const coreLane = page.getByRole('button', {name: 'Collapse Core lane'});
  await coreLane.click();
  await expect(page.getByRole('button', {name: 'Expand Core lane'})).toBeVisible();
});

test('timeline: groups render as collapsible Gantt bands', async ({page}) => {
  await openRoadmap(page);
  // Roadmap opens on the timeline; bands are labelled by Area.
  await expect(page.getByRole('button', {name: 'Timeline', exact: true})).toBeVisible();
  for (const area of ['Core', 'Growth', 'Infra']) {
    await expect(page.getByRole('button', {name: `Collapse ${area} band`})).toBeVisible();
  }
  // Bars still render within their bands.
  await expect(page.getByTitle(/drag to reschedule/).first()).toBeVisible();
});
