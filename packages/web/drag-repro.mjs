import {chromium} from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1280, height: 800}});
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
await page.addInitScript(() => localStorage.removeItem('obe-lab-doc'));
await page.goto('http://localhost:3000/editor-lab');
await page.locator('.obe-text').nth(2).waitFor();

// Inspect the handle: is it draggable at all?
const handle = page.locator('[data-block-row][data-block-type=todo] .obe-handle');
await page.locator('[data-block-row][data-block-type=todo]').hover();
console.log('handle count:', await handle.count());
console.log('draggable attr:', await handle.first().getAttribute('draggable'));
console.log('handle visible:', await handle.first().isVisible());

// Listen for dnd events on the document.
await page.evaluate(() => {
  window.__dnd = [];
  for (const t of ['dragstart', 'dragover', 'drop', 'dragend']) {
    document.addEventListener(t, () => window.__dnd.push(t), true);
  }
});

// Real mouse drag: from the todo's handle to beside the first paragraph.
const target = page.locator('[data-block-row][data-block-type=paragraph]').first();
await handle.first().dragTo(target, {targetPosition: {x: 600, y: 10}});
await page.waitForTimeout(400);
console.log('dnd events:', await page.evaluate(() => window.__dnd.slice(0, 10)));
console.log('columns:', await page.locator('.obe-columns').count());
console.log('order:', await page.evaluate(() => [...document.querySelectorAll('[data-block-type]')].map(e => e.dataset.blockType).join(',')));
await page.screenshot({path: '/tmp/drag-repro.png'});
await browser.close();
