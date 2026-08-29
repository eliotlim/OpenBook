import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const server = readFileSync(resolve(root, 'src/server.ts'), 'utf8');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const registered = [...server.matchAll(/registerTool\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
const toolsSection = readme.slice(readme.indexOf('## Tools'), readme.indexOf('\n## ', readme.indexOf('## Tools') + 1));
const toolRows = toolsSection.split('\n').filter((line) => line.startsWith('| `'));
const documented = new Set(toolRows.flatMap((line) => [...((line.split('|')[1] ?? '').matchAll(/`([^`]+)`/g))].map((m) => m[1])));

assert.ok(registered.length > 0, 'server.registerTool names were found');
assert.deepEqual(registered.filter((name) => !documented.has(name)), [], 'README tool table lists every registered tool');
assert.deepEqual([...documented].filter((name) => !registered.includes(name)), [], 'every README tool-table entry is registered');
for (const section of ['## Block prop reference', '### Reactive expression grammar', '### Images via MCP', '### Rich text input']) {
  assert.match(readme, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
console.log(`✅ README covers all ${registered.length} registered MCP tools and agent reference sections`);
