/**
 * **Run-as-artifact HTML import** — the second landing path for a `.html` file
 * that is NOT an OpenBook export. Instead of converting the visible markup to
 * editable blocks (`htmlToImportedDoc`), the file lands VERBATIM: its bytes go
 * to the content-addressed asset store and a new page holds one `htmlArtifact`
 * block rendering them through the sandboxed-iframe surface (never
 * `allow-same-origin` — see lib/srcdoc.ts). Scripts keep working; nothing is
 * converted or rewritten.
 *
 * ## The seam with island-first import (feat/island-first-import)
 * {@link artifactChoiceFor} is the ONE function that decides whether the Import
 * dialog offers the artifact-vs-convert chooser, and it keys off
 * `parseHtmlImport`'s result: an **island** file (an OpenBook export) returns
 * `null` — no chooser, the lossless island restore owns that path entirely —
 * while a foreign `doc` file gets a choice payload. Island handling itself
 * lives in `islandImport.ts`; this module never reads islands.
 *
 * Pure string/regex throughout (no DOM), mirroring the island reader contract,
 * so the heuristic + title extraction are unit-testable anywhere.
 */
import {
  HTML_ARTIFACT_PENDING_PROP,
  htmlArtifactPendingBlock,
  importDoc,
  type ImportWriteClient,
  type ImportWriteResult,
  type ImportedBlock,
  type PageSnapshot,
  type RehydrateStoredClient,
} from '@book.dev/sdk';
import {MAX_ASSET_BYTES} from '@/blockeditor/imageBlock';
import {titleFromFileName} from './importContent';
import type {ParsedHtmlImport} from './htmlImport';

/** Everything the dialog needs to land (or offer) a run-as-artifact import. */
export interface ArtifactImportChoice {
  /** The file's original text — uploaded verbatim on import. */
  html: string;
  /** New page title: the document's `<title>`, else the file name. */
  title: string;
  /** Heuristic default: preselect "run as artifact" for script/canvas files. */
  preferArtifact: boolean;
}

/**
 * Should a foreign `.html` file DEFAULT to importing as an interactive artifact?
 * `<script>` or `<canvas>` means the file has behaviour that a block conversion
 * would strip, so running it sandboxed is the faithful default; plain markup
 * defaults to the editable-blocks conversion. A pure string scan (comments and
 * quoted text can fool it) — it only picks the preselection, and the user can
 * flip the choice before importing.
 */
export function preferArtifactImport(html: string): boolean {
  return /<(script|canvas)[\s>]/i.test(html ?? '');
}

/** Decode the few entities that legitimately appear in `<title>` text. */
function decodeTitleEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, '\'')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&');
}

/**
 * The document's `<title>` text (entity-decoded, whitespace-collapsed), or
 * `null` when absent/empty — the caller falls back to the file name.
 */
export function htmlDocTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html ?? '');
  if (!m) return null;
  const text = decodeTitleEntities(m[1]).replace(/\s+/g, ' ').trim();
  return text || null;
}

/**
 * THE chooser seam: given `parseHtmlImport`'s result for a picked `.html` file,
 * return the artifact-vs-convert choice payload — or `null` for an island file,
 * which bypasses the chooser entirely (OpenBook exports restore losslessly via
 * `runIslandImport`; that path owns its own preview and never offers a
 * conversion). Title precedence: the document's `<title>`, then the file name.
 */
export function artifactChoiceFor(parsed: ParsedHtmlImport, html: string, fileName: string): ArtifactImportChoice | null {
  if (parsed.kind !== 'doc') return null; // island → lossless restore, no chooser
  return {
    html,
    title: htmlDocTitle(html) ?? titleFromFileName(fileName) ?? '',
    preferArtifact: preferArtifactImport(html),
  };
}

/** The client surface a run-as-artifact import drives (the data client has it all). */
export type ArtifactImportClient = ImportWriteClient & RehydrateStoredClient;

/**
 * Land a run-as-artifact import: create a new page titled `choice.title` whose
 * body is one pending `htmlArtifact` block (via the normal `importDoc` IR path,
 * so create-strategy semantics — fresh id, `(imported)` retry ladder — apply),
 * then upload the file's bytes (`putAsset`, ref'd to the landed page) and
 * rewrite the pending block to the returned `assetId`. Same land-then-rehydrate
 * order as imported images: `putAsset` needs the landed page id first.
 *
 * Degrades without dropping: a failed upload/rewrite leaves the pending block,
 * which renders as the editor's visible "add an artifact" placeholder — the
 * page (and the file pick) is never silently lost. An over-cap file fails fast
 * with a friendly error BEFORE anything lands.
 */
export async function runArtifactImport(client: ArtifactImportClient, choice: ArtifactImportChoice): Promise<ImportWriteResult> {
  const bytes = new TextEncoder().encode(choice.html);
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error('That HTML file is over 10 MB — the maximum size for an uploaded artifact.');
  }
  const title = choice.title.trim() || 'HTML artifact';
  const result = await importDoc(client, {pages: [{title, blocks: [htmlArtifactPendingBlock(title)]}]});

  for (const pageId of result.pageIds) {
    try {
      const {id: assetId} = await client.putAsset(bytes, 'text/html', pageId);
      const page = await client.getPage(pageId);
      if (!page) continue;
      const blockdoc = page.data?.blockdoc as {blocks?: ImportedBlock[]} | undefined;
      const blocks = blockdoc?.blocks;
      if (!blocks) continue;
      const next = blocks.map((b) => {
        if (b.type !== 'htmlArtifact' || !b.props?.[HTML_ARTIFACT_PENDING_PROP]) return b;
        const props: Record<string, unknown> = {...b.props, assetId};
        delete props[HTML_ARTIFACT_PENDING_PROP];
        return {...b, props};
      });
      const data: PageSnapshot = {...page.data, blockdoc: {...(blockdoc ?? {}), blocks: next}};
      await client.savePage({id: page.id, name: page.name, data});
    } catch {
      // Upload/rewrite failed — the pending block stays as a visible placeholder
      // on the landed page (degrade-never-drop); the import itself succeeded.
    }
  }
  return result;
}
