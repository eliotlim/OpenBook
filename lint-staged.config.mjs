import {readFileSync} from 'node:fs';
import {relative, sep} from 'node:path';

/**
 * lint-staged: the fast pre-commit gate (it replaced the old `pnpm test` hook,
 * which ran the whole recursive vitest suite, hung, and trained everyone to
 * `--no-verify` — which also skipped commitlint).
 *
 * For staged TS/TSX it runs `eslint --fix` on just those files (the root flat
 * `eslint.config.mjs` covers every package), then a scoped, whole-package
 * `tsc --noEmit` for each package that has staged changes. The scoped type-check
 * is seconds — not the whole repo — and catches cross-file type breaks that a
 * per-file lint can't see.
 */

/** The distinct `packages/<dir>` names a set of absolute paths belong to. */
function packageDirs(files) {
  const dirs = new Set();
  for (const file of files) {
    const parts = relative(process.cwd(), file).split(sep);
    if (parts[0] === 'packages' && parts[1]) dirs.add(parts[1]);
  }
  return dirs;
}

/** A workspace package's name (`@book.dev/<x>`), read from its package.json. */
function packageName(dir) {
  try {
    return JSON.parse(readFileSync(`packages/${dir}/package.json`, 'utf8')).name;
  } catch {
    return null;
  }
}

export default {
  '*.{ts,tsx}': (files) => {
    const quoted = files.map((f) => JSON.stringify(f)).join(' ');
    const cmds = [`eslint --fix ${quoted}`];
    for (const dir of packageDirs(files)) {
      const name = packageName(dir);
      if (name) cmds.push(`pnpm --filter ${name} run --if-present typecheck`);
    }
    return cmds;
  },
};
