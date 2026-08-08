/**
 * Drift guards between the RUNTIME block registries and the SDK's types-only
 * block-type catalogue (API-2) — the source the server agent and MCP server
 * validate against and serve from `list_block_types`.
 *
 *  1. Register every built-in custom block (artifact kit + reactive blocks +
 *     dbview) and require the registry and the catalogue's `kit` entries to
 *     match EXACTLY, both directions. Add a block type anywhere without
 *     cataloguing it (or vice versa) and this fails, naming the offender.
 *     (Proven red during development by registering a fake `sparkle` type.)
 *  2. The core union needs no runtime guard — `BlockType` IS the catalogue's
 *     `CoreBlockType` (model.ts derives it), so core drift is a type error.
 *     The nature sets are still asserted to match the model's exports.
 *  3. Every bundled plugin's manifest `blocks` declaration must match the
 *     `blocks.register` calls in its shipped source (the same rule
 *     scripts/bundlePlugins.ts enforces at bundle time — asserted here too so
 *     a hand-edited bundled.gen.ts can't sneak past).
 */
import {describe, expect, it} from 'vitest';
import {
  BLOCK_TYPE_CATALOGUE,
  CONTAINER_BLOCK_TYPES,
  KNOWN_BLOCK_TYPE_IDS,
  TEXT_BLOCK_TYPES,
} from '@book.dev/sdk';
import {registeredBlockTypes} from './registry';
import {registerArtifactKit} from './kit';
import {registerReactiveBlocks} from './reactiveBlocks';
import {INPUT_TYPES} from './kit/scope';
import {CONTAINER_BLOCKS, TEXT_BLOCKS} from './model';
import {registerDatabaseBlock} from '@/components/database/InlineDatabaseBlock';
import {BUNDLED_PLUGINS} from '@/plugins/bundled.gen';

describe('registry ↔ catalogue drift guard', () => {
  it('the runtime registry and the catalogue kit entries match exactly', () => {
    registerArtifactKit();
    registerReactiveBlocks();
    registerDatabaseBlock();
    const registered = new Set(registeredBlockTypes().filter((t) => !t.includes('/')));
    const catalogued = new Set(BLOCK_TYPE_CATALOGUE.filter((e) => e.category === 'kit').map((e) => e.type));
    // Registered but not catalogued → the agent/MCP would REJECT a block the
    // editor renders fine (the exact coverage bug API-2 fixes).
    expect([...registered].filter((t) => !catalogued.has(t))).toEqual([]);
    // Catalogued but never registered → the agent/MCP would ACCEPT a block the
    // editor renders as an "Unsupported block" placeholder.
    expect([...catalogued].filter((t) => !registered.has(t))).toEqual([]);
  });

  it('core types are all catalogued and never collide with registered custom blocks', () => {
    registerArtifactKit();
    registerReactiveBlocks();
    registerDatabaseBlock();
    for (const t of registeredBlockTypes()) {
      expect(BLOCK_TYPE_CATALOGUE.find((e) => e.type === t)?.category, t).not.toBe('core');
    }
    expect(KNOWN_BLOCK_TYPE_IDS.size).toBe(BLOCK_TYPE_CATALOGUE.length);
  });

  it('the model\'s nature sets ARE the catalogue\'s', () => {
    expect(TEXT_BLOCKS).toBe(TEXT_BLOCK_TYPES);
    expect(CONTAINER_BLOCKS).toBe(CONTAINER_BLOCK_TYPES);
  });

  it('kit-value support mirrors the scope INPUT_TYPES', () => {
    const declared = new Set(BLOCK_TYPE_CATALOGUE.filter((e) => e.kitValue).map((e) => e.type));
    expect([...INPUT_TYPES].sort()).toEqual([...declared].sort());
  });
});

describe('bundled plugin manifest ↔ source drift guard', () => {
  it('every bundled plugin declares exactly the blocks its source registers', () => {
    expect(BUNDLED_PLUGINS.length).toBeGreaterThan(0);
    for (const pkg of BUNDLED_PLUGINS) {
      const registered = new Set<string>();
      for (const content of Object.values(pkg.files)) {
        for (const m of content.matchAll(/blocks\.register\(\{\s*type:\s*'([^']+)'/g)) registered.add(m[1]);
      }
      const declared = new Set((pkg.manifest.blocks ?? []).map((b) => b.type));
      expect([...registered].filter((t) => !declared.has(t)), pkg.manifest.id).toEqual([]);
      expect([...declared].filter((t) => !registered.has(t)), pkg.manifest.id).toEqual([]);
    }
  });

  it('the ledger plugin declares its journal-entry block (list_block_types depends on it)', () => {
    const ledger = BUNDLED_PLUGINS.find((p) => p.manifest.id === 'openbook.ledger');
    expect(ledger?.manifest.blocks?.map((b) => b.type)).toContain('journal-entry');
  });
});
