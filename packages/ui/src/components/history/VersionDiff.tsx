import {Fragment, useEffect, useMemo, useState} from 'react';
import {useData} from '@/data';
import {useTranslation} from '@/providers';
import {Button} from '@/components/ui/button';
import {cn} from '@/lib/utils';
import {
  decodeSnapshot,
  docToJSON,
  type BlockDocSnapshot,
  type BlockJSON,
} from '@/blockeditor/model';
import {diffBlocks, type BlockDiffEntry, type WordRun} from '@/lib/blockDiff';

/**
 * PVH-6 — the block/word-level diff of a captured version against the CURRENT
 * document, shown in the Version-history pane when "Compare" is active.
 *
 * It decodes both snapshots the same way {@link VersionPreview} does (a fresh,
 * throwaway Y.Doc → its JSON projection), runs the pure {@link diffBlocks}
 * engine (version = old, current = new), and renders a text-focused diff:
 * added blocks tint green with a `＋` marker, removed blocks tint red with a `−`
 * marker and strikethrough, changed text blocks show inline word-level
 * insertions/deletions (`<ins>`/`<del>` — semantic, not colour-only), and
 * non-text blocks (images, charts, tables…) are shown opaquely as a
 * "{Type} changed" badge. Long runs of unchanged context collapse behind a toggle.
 */

/** A readable label for a non-text / structural block type in an opaque change. */
function blockTypeLabel(type: string): string {
  const map: Record<string, string> = {
    image: 'Image',
    htmlArtifact: 'HTML embed',
    divider: 'Divider',
    table: 'Table',
    columns: 'Columns',
    group: 'Group',
    tabs: 'Tabs',
    accordion: 'Accordion',
    chart: 'Chart',
    dbview: 'Database view',
    slider: 'Slider',
    formula: 'Formula',
    status: 'Status',
  };
  return map[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

/** The plain text of a block (empty for non-text blocks). */
const plain = (b: BlockJSON): string => (b.text ?? []).map((r) => r.t).join('');

/** A block whose text prefix hints at its structure (list bullet, heading, quote). */
function structuralPrefix(type: string): string {
  if (type === 'list' || type === 'todo') return '• ';
  if (type === 'quote') return '“ ';
  return '';
}

/** Inline word-run rendering: kept plain, added `<ins>`, removed `<del>`. */
function WordRuns({runs}: {runs: WordRun[]}) {
  return (
    <>
      {runs.map((run, i) => {
        if (run.status === 'added')
          return (
            <ins
              key={i}
              className="rounded-[3px] bg-emerald-500/20 px-0.5 text-emerald-800 no-underline dark:text-emerald-300"
            >
              {run.value}
            </ins>
          );
        if (run.status === 'removed')
          return (
            <del key={i} className="rounded-[3px] bg-destructive/15 px-0.5 text-destructive">
              {run.value}
            </del>
          );
        return <Fragment key={i}>{run.value}</Fragment>;
      })}
    </>
  );
}

/** One diff entry rendered as a marker gutter + content row. */
function DiffRow({entry}: {entry: BlockDiffEntry}) {
  const {t} = useTranslation();
  const type = entry.block.type;
  const text = plain(entry.block);

  // Marker glyph + accessible status label (never colour-only).
  const marker =
    entry.status === 'added'
      ? {sym: '＋', label: t('history.diffAdded'), tone: 'text-emerald-600 dark:text-emerald-400'}
      : entry.status === 'removed'
        ? {sym: '−', label: t('history.diffRemoved'), tone: 'text-destructive'}
        : entry.status === 'changed'
          ? {sym: '~', label: t('history.diffChanged'), tone: 'text-amber-600 dark:text-amber-400'}
          : {sym: '', label: '', tone: 'text-muted-foreground'};

  const rowTint =
    entry.status === 'added'
      ? 'bg-emerald-500/10'
      : entry.status === 'removed'
        ? 'bg-destructive/10'
        : entry.status === 'changed'
          ? 'bg-amber-500/10'
          : '';

  // Body: word-runs for a changed text block; a "{Type} changed" badge for an
  // opaque (non-text) change; otherwise the block's plain text with the right
  // tint. A changed text block whose word runs are all `kept` (identical text,
  // only props/formatting differ) shows a "Formatting changed" hint rather than
  // an empty runs row.
  let body: React.ReactNode;
  if (entry.status === 'changed' && entry.wordRuns) {
    const hasTextChange = entry.wordRuns.some((r) => r.status !== 'kept');
    body = hasTextChange ? (
      <WordRuns runs={entry.wordRuns} />
    ) : (
      <em className="text-muted-foreground">{t('history.diffFormattingChanged')}</em>
    );
  } else if (entry.status === 'changed' && entry.opaque) {
    body = (
      <span className="inline-flex items-center gap-1.5">
        <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium">
          {t('history.diffOpaqueChanged', {type: blockTypeLabel(type)})}
        </span>
      </span>
    );
  } else if (entry.status === 'removed') {
    body = isTextType(type) ? (
      text ? (
        <span className="text-destructive line-through">{text}</span>
      ) : (
        <em className="text-muted-foreground">{t('history.diffEmptyBlock')}</em>
      )
    ) : (
      <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-destructive">
        {blockTypeLabel(type)}
      </span>
    );
  } else if (entry.status === 'added') {
    body = isTextType(type) ? (
      text ? (
        <span className="text-emerald-700 dark:text-emerald-300">{text}</span>
      ) : (
        <em className="text-muted-foreground">{t('history.diffEmptyBlock')}</em>
      )
    ) : (
      <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
        {blockTypeLabel(type)}
      </span>
    );
  } else {
    // unchanged context
    body = isTextType(type) ? (
      <span className="text-muted-foreground">{text || <em>{t('history.diffEmptyBlock')}</em>}</span>
    ) : (
      <span className="rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        {blockTypeLabel(type)}
      </span>
    );
  }

  return (
    <div
      className={cn('flex gap-2 rounded-md px-2 py-1', rowTint)}
      data-diff-status={entry.status}
    >
      <span
        aria-hidden={marker.sym === ''}
        className={cn('mt-px w-3 shrink-0 select-none text-center font-mono text-xs', marker.tone)}
      >
        {marker.sym}
      </span>
      <div
        className={cn(
          'min-w-0 flex-1 break-words text-[13px] leading-relaxed',
          type === 'heading' && 'font-semibold',
          type === 'code' && 'whitespace-pre-wrap font-mono text-[12px]',
        )}
      >
        {marker.label && <span className="sr-only">{marker.label}: </span>}
        {structuralPrefix(type)}
        {body}
      </div>
    </div>
  );
}

/** Text-bearing block types (kept local so the engine stays the source of truth). */
function isTextType(type: string): boolean {
  return (
    type === 'paragraph' ||
    type === 'heading' ||
    type === 'list' ||
    type === 'todo' ||
    type === 'quote' ||
    type === 'callout' ||
    type === 'code' ||
    type === 'notes' ||
    type === 'cell'
  );
}

/** A run of consecutive unchanged entries, collapsible when long. */
function UnchangedRun({entries}: {entries: BlockDiffEntry[]}) {
  const {t} = useTranslation();
  const [open, setOpen] = useState(false);
  // Short runs (≤2) always show as context; longer runs collapse by default, so
  // the collapsed label's count is always ≥3 (plural only).
  if (entries.length <= 2) return <>{entries.map((e, i) => <DiffRow key={i} entry={e} />)}</>;
  const countLabel = t('history.diffUnchangedRunPlural', {count: entries.length});
  return (
    <div className="my-0.5">
      <Button
        size="sm"
        variant="ghost"
        className="h-6 w-full justify-start px-2 text-[11px] text-muted-foreground"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="mr-1.5 font-mono">{open ? '−' : '⋯'}</span>
        {open ? t('history.diffHideUnchanged') : countLabel}
      </Button>
      {open && (
        <div className="border-l-2 border-dashed border-border/60 pl-1">
          {entries.map((e, i) => (
            <DiffRow key={i} entry={e} />
          ))}
        </div>
      )}
    </div>
  );
}

export function VersionDiff({pageId, versionId}: {pageId: string; versionId: string}) {
  const client = useData();
  const {t} = useTranslation();
  const [state, setState] = useState<
    {kind: 'loading'} | {kind: 'error'} | {kind: 'ready'; oldB: BlockJSON[]; newB: BlockJSON[]}
  >({kind: 'loading'});

  useEffect(() => {
    let cancelled = false;
    setState({kind: 'loading'});
    void (async () => {
      try {
        const [current, version] = await Promise.all([
          client.getPage(pageId),
          client.getVersion(pageId, versionId),
        ]);
        if (cancelled) return;
        if (!current || !version) {
          setState({kind: 'error'});
          return;
        }
        const toBlocks = (data: unknown): BlockJSON[] => {
          const snapshot = (data as {blockdoc?: unknown}).blockdoc as BlockDocSnapshot | undefined;
          const doc = decodeSnapshot(snapshot);
          const json = docToJSON(doc);
          doc.destroy();
          return json;
        };
        setState({kind: 'ready', oldB: toBlocks(version.data), newB: toBlocks(current.data)});
      } catch {
        if (!cancelled) setState({kind: 'error'});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, pageId, versionId]);

  const diff = useMemo(
    () => (state.kind === 'ready' ? diffBlocks(state.oldB, state.newB) : null),
    [state],
  );

  // Group consecutive unchanged entries so long context runs can collapse.
  const groups = useMemo(() => {
    if (!diff) return [];
    const out: Array<{kind: 'change'; entry: BlockDiffEntry} | {kind: 'context'; entries: BlockDiffEntry[]}> = [];
    for (const entry of diff.entries) {
      if (entry.status === 'unchanged') {
        const last = out[out.length - 1];
        if (last && last.kind === 'context') last.entries.push(entry);
        else out.push({kind: 'context', entries: [entry]});
      } else {
        out.push({kind: 'change', entry});
      }
    }
    return out;
  }, [diff]);

  if (state.kind === 'loading')
    return <p className="text-xs text-muted-foreground">{t('history.diffLoading')}</p>;
  if (state.kind === 'error' || !diff)
    return <p className="text-xs text-muted-foreground">{t('history.diffError')}</p>;
  if (!diff.changed)
    return <p className="text-xs text-muted-foreground">{t('history.diffNoChanges')}</p>;

  return (
    <div className="flex flex-col gap-0.5" role="group" aria-label={t('history.compare')}>
      {groups.map((g, i) =>
        g.kind === 'context' ? (
          <UnchangedRun key={i} entries={g.entries} />
        ) : (
          <DiffRow key={i} entry={g.entry} />
        ),
      )}
    </div>
  );
}

export default VersionDiff;
