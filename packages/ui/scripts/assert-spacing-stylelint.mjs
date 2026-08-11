import {fileURLToPath} from 'node:url';
import stylelint from 'stylelint';
import config from '../stylelint.config.mjs';

const codeFilename = fileURLToPath(new URL('../src/index.css', import.meta.url));
const rule = 'declaration-property-value-allowed-list';

async function warningsFor(code) {
  const result = await stylelint.lint({code, codeFilename, config});
  return result.results.flatMap(({warnings}) => warnings);
}

const validWarnings = await warningsFor('.spc2-positive-control { padding: 4px; }');
if (validWarnings.length !== 0) {
  throw new Error(`SPC-2 stylelint positive control failed: ${JSON.stringify(validWarnings)}`);
}

const invalidWarnings = await warningsFor('.spc2-negative-control { padding: 3px; }');
if (!invalidWarnings.some((warning) => warning.rule === rule)) {
  throw new Error('SPC-2 stylelint negative control did not reject padding: 3px');
}

console.log('SPC-2 stylelint negative control rejected padding: 3px');
