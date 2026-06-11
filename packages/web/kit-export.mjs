import {chromium} from '@playwright/test';

const SERVER = 'http://127.0.0.1:4319';
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1280, height: 900}});

const blockdoc = {
  blocks: [
    {id: 'n1', type: 'number', props: {name: 'done', label: 'Tasks done', value: 7, min: 0, max: 10, step: 1}},
    {id: 's1', type: 'statuslight', props: {label: 'Readiness', source: 'done * 10', okAt: 50, warnAt: 20}},
    {id: 'f1', type: 'formula', props: {source: 'done * 10'}},
  ],
};
const res = await page.request.post(`${SERVER}/api/pages`, {
  data: {name: `Kit Export ${Date.now()}`, data: {editor: 'blocks', blockdoc, editorjs: {blocks: []}, values: [], names: []}},
});
const {id} = await res.json();
await page.goto(`http://localhost:3000/?page=${id}`);
await page.locator('.obe-kit-status').waitFor();

// Export → HTML from the page actions dropdown.
await page.getByRole('button', {name: 'Page actions'}).click();
await page.getByRole('menuitem', {name: 'Export'}).hover();
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.getByRole('menuitem', {name: /HTML/}).click(),
]);
const path = await download.path();
console.log('downloaded:', download.suggestedFilename());

// Open the exported file: the stepper rides as a range input; moving it must
// recompute both exprs (status + formula).
const ex = await browser.newPage();
await ex.goto(`file://${path}`);
const slider = ex.locator('.reactive.slider input[type=range]');
console.log('sliders in export:', await slider.count());
const exprs = ex.locator('.reactive.expr [data-val]');
console.log('exprs before:', await exprs.allTextContents());
await slider.fill('3');
await ex.waitForTimeout(200);
console.log('exprs after slider→3:', await exprs.allTextContents());
await ex.screenshot({path: '/tmp/kit-export.png', fullPage: true});
await browser.close();
