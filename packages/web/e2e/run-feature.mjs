// Convenience wrapper: run one feature area's Playwright e2e suite by its
// @<feature> tag, so a dev can iterate on a single area without naming specs.
//
// Usage (from packages/web, or via `pnpm --filter @book.dev/web`):
//   pnpm test:e2e:feature database             → playwright test --grep @database
//   pnpm test:e2e:feature shell -- --headed    → extra args pass through to Playwright
//   pnpm test:e2e:feature database -- --list    → just list the matching tests
//
// The @<feature> taxonomy is owned by the specs — exactly one feature tag per
// test (OB-221). Keep FEATURES in sync with that list.

import {spawn} from 'node:child_process';

// The nine feature tags applied across the e2e suite (T2 / OB-221).
const FEATURES = [
  'editor',
  'database',
  'shell',
  'export',
  'sharing',
  'ai',
  'plugins',
  'datalayer',
  'review',
];

const [feature, ...rest] = process.argv.slice(2);

if (!feature || !FEATURES.includes(feature)) {
  const reason = feature ? `unknown feature "${feature}"` : 'missing feature name';
  console.error(`test:e2e:feature: ${reason}.`);
  console.error('Usage: pnpm test:e2e:feature <feature> [-- <extra playwright args>]');
  console.error(`Valid features: ${FEATURES.join(', ')}`);
  process.exit(2);
}

// Drop the bare `--` separator that npm/pnpm may forward; otherwise Playwright
// would treat the following flag (e.g. `--list`) as a positional test filter.
const passthrough = rest.filter((arg) => arg !== '--');

const child = spawn('playwright', ['test', '--grep', `@${feature}`, ...passthrough], {
  stdio: 'inherit',
});
child.on('error', (err) => {
  console.error(`test:e2e:feature: failed to launch playwright: ${err.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
