import * as Y from 'yjs';
import {strToU8, zipSync} from 'fflate';
import {validateManifest, type PluginManifest} from '@book.dev/sdk';
import {blockProp, blockText, blockType, rootBlocks, walkBlocks} from '../blockeditor/model';

/**
 * A page can BE a plugin: every named, non-live code block is a file in the
 * package — name a block `openbook.json` for the manifest, `src/index.ts`
 * for the entry, and export the page as an installable zip. Live blocks'
 * names are reactive outputs, not filenames, so they stay out.
 */

export const MANIFEST_FILE = 'openbook.json';

/** Named, non-live code blocks in document order → path → content. */
export function pagePluginFiles(doc: Y.Doc): Map<string, string> {
  const files = new Map<string, string>();
  for (const {block} of walkBlocks(rootBlocks(doc))) {
    if (blockType(block) !== 'code') continue;
    if (blockProp<boolean>(block, 'live')) continue;
    const name = (blockProp<string>(block, 'name') ?? '').trim();
    if (!name) continue;
    files.set(name, blockText(block)?.toString() ?? '');
  }
  return files;
}

/** Does this page carry a plugin manifest block? Gates the export menu item. */
export const pageHasPluginManifest = (doc: Y.Doc): boolean => pagePluginFiles(doc).has(MANIFEST_FILE);

/**
 * Zip the page's plugin files — the same layout {@link parsePluginZip}
 * installs, so export → install round-trips. Throws with a human-readable
 * reason when the manifest is malformed or the entry file is missing.
 */
export function pageToPluginZip(doc: Y.Doc): {filename: string; bytes: Uint8Array} {
  const files = pagePluginFiles(doc);
  const manifestSource = files.get(MANIFEST_FILE);
  if (!manifestSource) throw new Error(`name a code block "${MANIFEST_FILE}" to define the plugin manifest`);
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(manifestSource) as PluginManifest;
  } catch {
    throw new Error(`${MANIFEST_FILE} is not valid JSON`);
  }
  const invalid = validateManifest(manifest);
  if (invalid) throw new Error(invalid);
  if (!files.has(manifest.main)) throw new Error(`the entry file "${manifest.main}" has no matching named code block`);

  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of files) entries[path] = strToU8(content);
  return {filename: `${manifest.id}-${manifest.version}.zip`, bytes: zipSync(entries)};
}
