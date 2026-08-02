import {readFileSync, readdirSync} from 'node:fs';
import {join, relative, sep} from 'node:path';
import {zipSync, strToU8} from 'fflate';
import {expect} from './fixtures';
import type {Page} from '@playwright/test';

/**
 * Shared harness for the first-party ledger plugin in e2e.
 *
 * The file list is WALKED FROM DISK, never hard-coded. A hand-maintained list
 * is a trap: `src/index.ts` imports every module, so a zip missing one fails to
 * ACTIVATE, and the failure surfaces as unrelated red tests in whichever spec
 * happens to install it (adding the LGR-8 report modules took out five LGR-5
 * journal tests exactly this way). Deriving the list means adding a module can
 * never desynchronise the specs from the package again.
 *
 * One helper, imported by both specs, so the derivation exists in one place.
 */

export const LEDGER_PLUGIN_DIR = join(__dirname, '..', '..', '..', 'examples', 'plugins', 'ledger');

/** Every shippable file under the plugin dir, as zip-relative POSIX paths. */
export function ledgerPluginFiles(dir: string = LEDGER_PLUGIN_DIR): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, {withFileTypes: true})) {
      // `dist`/`build` do not exist under the plugin today — but the day one
      // does, walking it would ship a second, stale copy of every module.
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      // The loader accepts these extensions plus the manifest; anything else in
      // the directory is not part of the package.
      else if (/\.(ts|tsx|js|jsx|json)$/.test(entry.name)) out.push(relative(dir, full).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

/** The plugin as an installable zip, built from whatever is on disk right now. */
export function ledgerPluginZip(dir: string = LEDGER_PLUGIN_DIR): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const file of ledgerPluginFiles(dir)) entries[file] = strToU8(readFileSync(join(dir, file), 'utf8'));
  return Buffer.from(zipSync(entries));
}

/** Open Settings → Extensions. */
export async function openExtensions(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('button', {name: 'Page actions'})).toBeVisible();
  await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('button', {name: 'Extensions', exact: true}).click();
}

/**
 * Install the shipped plugin through the real Extensions UI, once per worker
 * (spec files share a worker's data server, so a second install is a no-op).
 */
export async function ensureLedgerPlugin(page: Page): Promise<void> {
  await openExtensions(page);
  // Anchor on the panel being RENDERED before asking whether the plugin is
  // there: `count() === 0` is trivially true on a panel that has not painted
  // yet, which would install a second copy and race the first to `active`.
  const upload = page.locator('[data-extension-file]');
  await expect(upload).toBeAttached();
  const extension = page.locator('[data-extension="openbook.ledger"]');
  if ((await extension.count()) === 0) {
    await upload.setInputFiles({name: 'ledger.zip', mimeType: 'application/zip', buffer: ledgerPluginZip()});
  }
  await expect(extension).toHaveAttribute('data-extension-state', 'active');
  await page.keyboard.press('Escape');
}
