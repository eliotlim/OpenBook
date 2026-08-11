// SPC-1 spacing consistency baseline. This script measures debt; it never gates.
// Run from any directory with: node docs/design/spc-1-spacing-audit.mjs

import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, relative, sep} from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CSS_PATH = join(ROOT, 'packages/ui/src/index.css');
const TSX_ROOTS = [join(ROOT, 'packages/ui/src'), join(ROOT, 'packages/web/src')];

function repoPath(path) {
  return relative(ROOT, path).split(sep).join('/');
}

function sourceFiles(directory) {
  return readdirSync(directory, {withFileTypes: true})
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith('.tsx') ? [path] : [];
    });
}

// Replace comment contents, but retain newlines so future detail output can add
// stable source locations without changing the parser.
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

function declarations(source, propertyPattern) {
  const pattern = new RegExp(
    String.raw`(?:^|[;{])\s*(${propertyPattern})\s*:\s*([^;{}]+)`,
    'gim',
  );
  return [...source.matchAll(pattern)].map((match) => ({
    property: match[1].toLowerCase(),
    value: match[2].trim(),
  }));
}

function lengths(value) {
  return [...value.matchAll(/(-?(?:\d*\.)?\d+)(rem|px)\b/gi)].map((match) => {
    const number = Math.abs(Number(match[1]));
    return match[2].toLowerCase() === 'rem' ? number * 16 : number;
  });
}

// Tailwind's authored spacing scale is based on 4px, with named half steps used
// by the canonical dense recipes (notably 6px and 10px). Hairline 1px/2px values
// are valid for borders, but are not spacing-grid values.
const SPACING_SCALE_PX = new Set([
  0, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 36, 40, 44, 48, 56, 64, 80, 96,
  112, 128, 144, 160, 176, 192, 208, 224, 240, 256, 288, 320, 384,
]);

const css = withoutComments(readFileSync(CSS_PATH, 'utf8'));
const spacingDeclarations = declarations(
  css,
  String.raw`(?:padding|margin)(?:-(?:top|right|bottom|left|inline(?:-start|-end)?|block(?:-start|-end)?))?|gap|row-gap|column-gap`,
).map((declaration) => ({...declaration, lengths: lengths(declaration.value)}));
const spacingWithLengths = spacingDeclarations.filter((declaration) => declaration.lengths.length > 0);
const offGridSpacing = spacingWithLengths.filter((declaration) =>
  declaration.lengths.some((value) => !SPACING_SCALE_PX.has(value)),
);
const offGridSpacingValues = offGridSpacing.reduce(
  (count, declaration) =>
    count + declaration.lengths.filter((value) => !SPACING_SCALE_PX.has(value)).length,
  0,
);

const radiusDeclarations = declarations(css, String.raw`border-radius`);
const sharedRadiusToken = /var\(--radius(?:\)|-)/;
const canonicalLiteralRadiusPx = new Set([4, 6, 8, 999, 9999]);
function isCanonicalRadius(value) {
  if (value.includes('var(--')) return true;
  return value
    .toLowerCase()
    .split(/[\s/]+/)
    .filter(Boolean)
    .every((part) => {
      if (part === '0' || part === '50%') return true;
      const match = part.match(/^(-?(?:\d*\.)?\d+)(rem|px)$/);
      if (!match) return false;
      const number = Math.abs(Number(match[1]));
      const pixels = match[2] === 'rem' ? number * 16 : number;
      return canonicalLiteralRadiusPx.has(pixels);
    });
}

const sharedRadiusTokenDeclarations = radiusDeclarations.filter(({value}) =>
  sharedRadiusToken.test(value),
);
const offTokenRadiusDeclarations = radiusDeclarations.filter(
  ({value}) => !isCanonicalRadius(value),
);

const arbitraryUtilityPatterns = {
  spacing: /(?<![A-Za-z0-9_-])-?(?:p[trblxy]?|m[trblxy]?|gap(?:-[xy])?|space-[xy])-\[[^\]\s]+\]/g,
  sizing: /(?<![A-Za-z0-9_-])(?:size|w|min-w|max-w|h|min-h|max-h)-\[[^\]\s]+\]/g,
  position: /(?<![A-Za-z0-9_-])-?(?:inset(?:-[xy])?|top|right|bottom|left|start|end)-\[[^\]\s]+\]/g,
};
const arbitraryUtilities = Object.fromEntries(
  Object.keys(arbitraryUtilityPatterns).map((category) => [category, []]),
);
const tsxFiles = TSX_ROOTS.flatMap(sourceFiles);
for (const file of tsxFiles) {
  const source = readFileSync(file, 'utf8');
  for (const [category, pattern] of Object.entries(arbitraryUtilityPatterns)) {
    for (const match of source.matchAll(pattern)) {
      arbitraryUtilities[category].push({file: repoPath(file), utility: match[0]});
    }
  }
}
const arbitraryLayout = Object.values(arbitraryUtilities).flat();

const report = [
  ['audit.version', 1],
  ['audit.mode', 'measure-only'],
  ['css.path', repoPath(CSS_PATH)],
  ['css.spacing.declarations_with_lengths', spacingWithLengths.length],
  ['css.spacing.off_grid_declarations', offGridSpacing.length],
  ['css.spacing.off_grid_values', offGridSpacingValues],
  ['css.radius.declarations', radiusDeclarations.length],
  ['css.radius.shared_token_declarations', sharedRadiusTokenDeclarations.length],
  [
    'css.radius.hardcoded_or_local_declarations',
    radiusDeclarations.length - sharedRadiusTokenDeclarations.length,
  ],
  ['css.radius.off_token_declarations', offTokenRadiusDeclarations.length],
  ['tsx.files_scanned', tsxFiles.length],
  ['tsx.arbitrary.spacing_occurrences', arbitraryUtilities.spacing.length],
  ['tsx.arbitrary.sizing_occurrences', arbitraryUtilities.sizing.length],
  ['tsx.arbitrary.position_occurrences', arbitraryUtilities.position.length],
  ['tsx.arbitrary.layout_total_occurrences', arbitraryLayout.length],
  [
    'tsx.arbitrary.layout_unique_utilities',
    new Set(arbitraryLayout.map(({utility}) => utility)).size,
  ],
  ['status', 'ok'],
];

for (const [key, value] of report) console.log(`${key}=${value}`);
