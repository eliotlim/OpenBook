import {test, expect} from './fixtures';

// The database MAP view (T8), exercised through the `field-map` template — a
// database with a `location` property and a clustered, region-coloured map view,
// plus a row that has only an address (the unplaced / geocode case).

async function openFieldMap(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.getByRole('button', {name: 'Templates'}).click();
  await expect(page.getByText('Start with a template')).toBeVisible();
  await page.locator('[data-template="field-map"]').click();
  await expect(page.getByLabel('Page title')).toHaveValue(/^Field map/);
}

test('field-map template: lands on a map view with the Map and Table tabs', async ({page}) => {
  await openFieldMap(page);
  await expect(page.getByRole('button', {name: 'Map', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: 'Table', exact: true})).toBeVisible();
});

test('map renders Leaflet tiles, group-coloured markers, and a legend', async ({page}) => {
  await openFieldMap(page);

  // The Leaflet map mounts (lazy chunk) with the OSM tile layer + attribution.
  await expect(page.locator('.leaflet-container')).toBeVisible();
  await expect(page.getByRole('link', {name: 'OpenStreetMap'})).toBeVisible();

  // Placed rows render as tinted pins and/or cluster bubbles (both are our
  // divIcons). At the fitted world view dense regions collapse into clusters.
  await expect(page.locator('.ob-map-pin, .ob-map-cluster').first()).toBeVisible();

  // The legend lists the grouping property's options (markers coloured by Region).
  for (const region of ['Americas', 'EMEA', 'APAC']) {
    await expect(page.getByText(region, {exact: true}).first()).toBeVisible();
  }
});

test('the address-only row surfaces in the Unplaced affordance with a geocode action', async ({page}) => {
  await openFieldMap(page);
  // One seeded row (Lisbon partner) has an address but no coordinates.
  await expect(page.getByRole('button', {name: /Unplaced \(\d+\)/})).toBeVisible();
  await expect(page.getByRole('button', {name: /Geocode/})).toBeVisible();
});

test('switching to the Table view shows the location column and rows', async ({page}) => {
  await openFieldMap(page);
  await page.getByRole('button', {name: 'Table', exact: true}).click();
  await expect(page.getByRole('columnheader', {name: /Region/})).toBeVisible();
  // The seeded places are listed as rows.
  await expect(page.getByText('San Francisco HQ', {exact: true})).toBeVisible();
});
