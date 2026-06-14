import type * as Y from 'yjs';
import {blockChildren, blockProp, blockType, rootBlocks, type BlockMap} from '../model';
import {INPUT_TYPES, inputValue, publishedName} from './scope';
import {varNameFromLabel} from './options';

/**
 * Auto-computed completion for the container blocks (accordion sections, tabs).
 *
 * A section/tab is "complete" when every input it contains is *filled* and
 * every to-do it contains is checked. "Filled" depends on the value shape an
 * input publishes (see {@link inputValue}): a non-empty string, a finite
 * number that isn't the empty placeholder, `true` for a toggle, a non-empty
 * selection for the multi/array inputs. Containers with no inputs and no
 * to-dos are vacuously complete (so a purely informational section never
 * blocks a wizard).
 *
 * The signal is a READ — containers and the progress bar consume it; nothing
 * publishes a user-set "completion" value. Pure over the block tree so the
 * renderer, the progress-bar expression scope, and tests all agree.
 */

export interface CompletionStat {
  /** Inputs + to-dos that count toward completion. */
  total: number;
  /** Of those, how many are filled / checked. */
  done: number;
  /** `done === total` (vacuously true when total is 0). */
  complete: boolean;
  /** done / total, or 1 when there's nothing to complete. */
  ratio: number;
}

/** Whether one published value counts as "filled". */
function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** Walk a child list, tallying inputs (filled?) and to-dos (checked?). Does
 *  NOT descend into nested containers that own their own completion (tabs,
 *  accordion) — each owns its own progress; ordinary containers (columns,
 *  group, table) are transparent. */
function tally(list: Y.Array<BlockMap>, stat: CompletionStat): void {
  for (const block of list) {
    const type = blockType(block) as string;
    if (INPUT_TYPES.has(type)) {
      stat.total += 1;
      if (isFilled(inputValue(block))) stat.done += 1;
      continue;
    }
    if (type === 'todo') {
      stat.total += 1;
      if (blockProp<boolean>(block, 'checked')) stat.done += 1;
      continue;
    }
    if (type === 'tabs' || type === 'accordion') continue; // owns its own progress
    const children = blockChildren(block);
    if (children) tally(children, stat);
  }
}

/** Completion of the blocks directly held by `container` (a tab / section). */
export function sectionCompletion(container: BlockMap): CompletionStat {
  const stat: CompletionStat = {total: 0, done: 0, complete: true, ratio: 1};
  const children = blockChildren(container);
  if (children) tally(children, stat);
  stat.complete = stat.done >= stat.total;
  stat.ratio = stat.total === 0 ? 1 : stat.done / stat.total;
  return stat;
}

/** Overall completion of a tabs/accordion block (sum across its sections). */
export function overallCompletion(block: BlockMap): CompletionStat {
  const stat: CompletionStat = {total: 0, done: 0, complete: true, ratio: 1};
  const sections = blockChildren(block);
  if (sections) {
    for (const section of sections) {
      const s = sectionCompletion(section);
      stat.total += s.total;
      stat.done += s.done;
    }
  }
  stat.complete = stat.done >= stat.total;
  stat.ratio = stat.total === 0 ? 1 : stat.done / stat.total;
  return stat;
}

/** The completion read a tabs/accordion publishes into the scope. Mirrors the
 *  overall stat plus a `sections` array of per-section stats — so a progress
 *  bar or formula can bind `setup.ratio`, `setup.complete`, or
 *  `setup.sections[0].ratio`. */
export interface CompletionRead extends CompletionStat {
  sections: CompletionStat[];
}

export function completionRead(block: BlockMap): CompletionRead {
  const overall = overallCompletion(block);
  const sections = (blockChildren(block) ?? new Array<BlockMap>()) as Iterable<BlockMap>;
  return {...overall, sections: [...sections].map(sectionCompletion)};
}

/**
 * Every tabs/accordion container's completion read, keyed by the container's
 * name (an identifier derived like a group's). Read-only — injected into the
 * input scope so the progress bar / formulas can bind it; nothing user-set.
 */
export function containerCompletions(doc: Y.Doc): Record<string, CompletionRead> {
  const out: Record<string, CompletionRead> = {};
  const visit = (list: Y.Array<BlockMap>): void => {
    for (const block of list) {
      const type = blockType(block) as string;
      if (type === 'tabs' || type === 'accordion') {
        // Reuse the input-name resolution (explicit `name`, else from a label).
        const key = publishedName(block) || varNameFromLabel(blockProp<string>(block, 'name') ?? '');
        if (key && !(key in out)) out[key] = completionRead(block);
      }
      const children = blockChildren(block);
      if (children) visit(children);
    }
  };
  visit(rootBlocks(doc));
  return out;
}
