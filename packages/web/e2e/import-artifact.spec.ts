import {writeFileSync} from 'node:fs';
import {test, expect} from './fixtures';

/**
 * ImportDialog: a foreign `.html` file (no OpenBook island) offers the
 * run-as-artifact vs convert-to-blocks chooser. Artifact lands the file
 * VERBATIM on a new page as one sandboxed htmlArtifact block (scripts keep
 * working — asserted via frameLocator in a real browser); convert keeps the
 * pre-existing block-conversion behaviour. Island files never see the chooser
 * (covered by import-roundtrip.spec.ts + the artifactImport unit tests).
 */

// Script-bearing fixture: the heuristic must preselect "run as artifact", and
// the imported artifact's inline JS must actually run.
const COUNTER_HTML = `<!doctype html>
<html>
  <head><title>Counter Widget</title></head>
  <body>
    <h2>Converted heading</h2>
    <p>Converted paragraph text.</p>
    <button id="btn" type="button" style="cursor:pointer">Count: 0</button>
    <script>
      var n = 0;
      var b = document.getElementById('btn');
      b.addEventListener('click', function () { n += 1; b.textContent = 'Count: ' + n; });
    </script>
  </body>
</html>`;

async function openImportWithFixture(
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
  fileName: string,
): Promise<void> {
  const file = testInfo.outputPath(fileName);
  writeFileSync(file, COUNTER_HTML);
  await page.goto('/?page=home');
  await page.getByRole('button', {name: 'Bring your content'}).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.locator('input[type=file]').setInputFiles(file);
}

test('importing a script-bearing .html as an artifact lands a working sandboxed page', {tag: ['@editor']}, async ({page}, testInfo) => {
  await openImportWithFixture(page, testInfo, 'counter-widget.html');

  // The chooser appears with "run as artifact" PRESELECTED (script heuristic —
  // native radios, so checked state is real input state and arrow keys work).
  const chooser = page.getByRole('radiogroup', {name: 'How should this HTML file land?'});
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole('radio', {name: /Run as interactive artifact/})).toBeChecked();
  await expect(chooser.getByRole('radio', {name: /Convert to editable blocks/})).not.toBeChecked();
  // The heuristic explains its preselection…
  await expect(page.getByText('This file contains scripts', {exact: false})).toBeVisible();
  // …and the tally reflects the artifact landing (one page), not conversion counts.
  await expect(page.getByText('Ready to import 1 page.', {exact: false})).toBeVisible();

  await page.getByRole('button', {name: 'Import', exact: true}).click();
  await expect(page.getByText('Import complete')).toBeVisible();
  await page.getByRole('button', {name: 'View imported'}).click();

  // A NEW page titled from the fixture's <title>, holding the sandboxed
  // artifact — whose inline script RUNS (the counter counts).
  await expect(page.getByLabel('Page title')).toHaveValue('Counter Widget');
  const btn = page.frameLocator('.obe-artifact iframe').locator('#btn');
  await expect(btn).toHaveText('Count: 0');
  await btn.click();
  await expect(btn).toHaveText('Count: 1');

  // Verbatim landing: no converted blocks alongside the artifact.
  await expect(page.locator('.obe-h2')).toHaveCount(0);
});

test('the same dialog, flipped to convert, keeps the block-conversion result', {tag: ['@editor']}, async ({page}, testInfo) => {
  await openImportWithFixture(page, testInfo, 'counter-widget-convert.html');

  // Flip the preselected artifact choice over to conversion (native radio).
  const chooser = page.getByRole('radiogroup', {name: 'How should this HTML file land?'});
  await chooser.getByRole('radio', {name: /Convert to editable blocks/}).check();
  await expect(chooser.getByRole('radio', {name: /Convert to editable blocks/})).toBeChecked();

  await page.getByRole('button', {name: 'Import', exact: true}).click();
  await expect(page.getByText('Import complete')).toBeVisible();
  await page.getByRole('button', {name: 'View imported'}).click();

  // The pre-existing conversion result: editable blocks, no sandboxed frame.
  await expect(page.getByText('Converted paragraph text.')).toBeVisible();
  await expect(page.locator('.obe-h2 .obe-text').first()).toHaveText('Converted heading');
  await expect(page.locator('.obe-artifact')).toHaveCount(0);
});
