import {chromium} from '@playwright/test';
import {readFileSync} from 'node:fs';
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1280, height: 900}});
await page.goto('http://localhost:3000/');
await page.getByRole('button', {name: 'Page actions'}).waitFor();
await page.keyboard.press('Meta+,');
await page.getByRole('button', {name: 'Extensions', exact: true}).click();
await page.waitForTimeout(300);
// Install the signed example (dev-key → pinned key → Verified badge).
await page.locator('[data-extension-file]').setInputFiles({name: 'hello.zip', mimeType: 'application/zip', buffer: readFileSync('/tmp/hello-signed.zip')});
await page.locator('[data-extension="openbook.hello"]').waitFor();
await page.waitForTimeout(400);
await page.screenshot({path: '/tmp/extensions.png'});
console.log('verified badge:', await page.locator('[data-extension-verified]').count());
await browser.close();
