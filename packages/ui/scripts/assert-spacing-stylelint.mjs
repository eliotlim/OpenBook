import {fileURLToPath} from 'node:url';
import stylelint from 'stylelint';
import config from '../stylelint.config.mjs';

const codeFilename = fileURLToPath(new URL('../src/index.css', import.meta.url));
const rule = 'declaration-property-value-allowed-list';

async function warningsFor(code) {
  const result = await stylelint.lint({code, codeFilename, config});
  return result.results.flatMap(({warnings}) => warnings);
}

async function assertAllowed(declaration) {
  const warnings = await warningsFor(`.spc2-positive-control { ${declaration}; }`);
  if (warnings.length !== 0) {
    throw new Error(`SPC-2 stylelint positive control failed for ${declaration}: ${JSON.stringify(warnings)}`);
  }
}

async function assertRejected(declaration) {
  const warnings = await warningsFor(`.spc2-negative-control { ${declaration}; }`);
  if (!warnings.some((warning) => warning.rule === rule)) {
    throw new Error(`SPC-2 stylelint negative control did not reject ${declaration}`);
  }
}

await assertAllowed('padding: 4px');
await assertAllowed('padding: calc(var(--x) + 4px)');

await assertRejected('padding: 3px');
await assertRejected('padding: calc(7px + var(--x))');
await assertRejected('border-radius: calc(var(--radius) + 3px)');
await assertRejected('PADDING: 7PX');

console.log('SPC-2 stylelint controls passed (2 positive, 4 negative)');
