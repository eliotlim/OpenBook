import {strToU8, strFromU8, zipSync, unzipSync} from 'fflate';
import type {BookFolderFile} from '@book.dev/sdk';
import {downloadBlob} from './download';

/**
 * Browser implementations of "export my books to a folder" / "import a folder",
 * the default the web shell uses when the host platform supplies no native
 * `bookFolder` capability. Where the File System Access API is available
 * (Chromium), it writes/reads a real chosen directory; elsewhere (Safari,
 * Firefox) it falls back to a single `.zip` download / upload so the feature
 * still works everywhere.
 *
 * The desktop's WKWebView lacks the File System Access API, so the Tauri shell
 * provides its own `platform.bookFolder` using native dialogs — this module is
 * never its path.
 */

interface WritableLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
interface FileHandleLike {
  createWritable(): Promise<WritableLike>;
  getFile(): Promise<File>;
}
interface DirHandleLike {
  name: string;
  getDirectoryHandle(name: string, opts?: {create?: boolean}): Promise<DirHandleLike>;
  getFileHandle(name: string, opts?: {create?: boolean}): Promise<FileHandleLike>;
  values(): AsyncIterable<DirHandleLike | (FileHandleLike & {kind: string; name: string})>;
  kind: string;
}
type DirPicker = (opts?: {mode?: 'read' | 'readwrite'}) => Promise<DirHandleLike>;

const dirPicker = (): DirPicker | null => {
  const fn = (globalThis as {showDirectoryPicker?: DirPicker}).showDirectoryPicker;
  return typeof fn === 'function' ? fn.bind(globalThis) : null;
};

/** Was this thrown because the user dismissed the OS picker? Treat as cancel. */
const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

const htmlCount = (files: BookFolderFile[]): number => files.filter((f) => f.path.endsWith('.html')).length;

/** Write one file (creating intermediate folders) into a directory handle. */
async function writeInto(dir: DirHandleLike, path: string, contents: string): Promise<void> {
  const parts = path.split('/');
  let cursor = dir;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor = await cursor.getDirectoryHandle(parts[i], {create: true});
  }
  const handle = await cursor.getFileHandle(parts[parts.length - 1], {create: true});
  const writable = await handle.createWritable();
  await writable.write(contents);
  await writable.close();
}

/**
 * Export `files` to a folder the user picks (Chromium) or, failing that, a
 * downloaded `.zip` named from `suggestedName`. Resolves a summary, or `null` if
 * the user cancelled the directory picker.
 */
export async function exportBookFolderInBrowser(
  files: BookFolderFile[],
  suggestedName: string,
): Promise<{location: string; count: number} | null> {
  const pick = dirPicker();
  if (pick) {
    let dir: DirHandleLike;
    try {
      dir = await pick({mode: 'readwrite'});
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
    for (const file of files) await writeInto(dir, file.path, file.contents);
    return {location: dir.name, count: htmlCount(files)};
  }

  // No File System Access API — bundle the same layout into a zip download.
  const tree: Record<string, Uint8Array> = {};
  for (const file of files) tree[file.path] = strToU8(file.contents);
  const zipped = zipSync(tree, {level: 6});
  downloadBlob(`${suggestedName}.zip`, new Blob([zipped as BlobPart], {type: 'application/zip'}));
  return {location: `${suggestedName}.zip`, count: htmlCount(files)};
}

/** Recursively collect every file in a directory handle, with relative paths. */
async function collectFiles(dir: DirHandleLike, prefix: string, out: BookFolderFile[]): Promise<void> {
  for await (const entry of dir.values()) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === 'directory') {
      await collectFiles(entry as DirHandleLike, rel, out);
    } else {
      const file = await (entry as unknown as FileHandleLike).getFile();
      out.push({path: rel, contents: await file.text()});
    }
  }
}

/** Prompt for a single `.zip` file and return it, or `null` if dismissed. */
function pickZipFile(): Promise<File | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') return resolve(null);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.zip,application/zip';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    // If the dialog is dismissed `onchange` never fires; the promise simply
    // stays pending, which is harmless (the caller's button re-enables on the
    // next interaction). Browsers don't expose a reliable cancel event here.
    input.click();
  });
}

/**
 * Import a book folder: read a user-picked directory (Chromium) or unzip a
 * user-picked `.zip` (fallback). Resolves the files, or `null` if cancelled.
 */
export async function importBookFolderInBrowser(): Promise<BookFolderFile[] | null> {
  const pick = dirPicker();
  if (pick) {
    let dir: DirHandleLike;
    try {
      dir = await pick({mode: 'read'});
    } catch (e) {
      if (isAbort(e)) return null;
      throw e;
    }
    const files: BookFolderFile[] = [];
    await collectFiles(dir, '', files);
    return files;
  }

  const file = await pickZipFile();
  if (!file) return null;
  const buf = new Uint8Array(await file.arrayBuffer());
  const entries = unzipSync(buf);
  return Object.entries(entries).map(([path, bytes]) => ({path, contents: strFromU8(bytes)}));
}
