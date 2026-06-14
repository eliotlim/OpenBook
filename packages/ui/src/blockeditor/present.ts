import * as Y from 'yjs';
import {rootBlocks, blockType, type BlockMap} from './model';

/**
 * Present mode splits a page into slides at every top-level `divider` block.
 * Within a slide, `notes` blocks are speaker-only (shown in the presenter view,
 * never to the audience); everything else is audience `content`.
 */
export interface Slide {
  content: BlockMap[];
  notes: BlockMap[];
}

/**
 * Group a document's top-level blocks into slides at each `divider`. A
 * divider-less doc is a single slide; leading/trailing/doubled dividers never
 * yield an empty slide; an empty doc yields one empty slide so the deck always
 * has something to show.
 */
export function splitSlides(doc: Y.Doc): Slide[] {
  const slides: Slide[] = [];
  let cur: Slide = {content: [], notes: []};
  const flush = (): void => {
    if (cur.content.length || cur.notes.length) slides.push(cur);
    cur = {content: [], notes: []};
  };
  for (const block of rootBlocks(doc)) {
    const type = blockType(block);
    if (type === 'divider') flush();
    else if (type === 'notes') cur.notes.push(block);
    else cur.content.push(block);
  }
  flush();
  return slides.length ? slides : [{content: [], notes: []}];
}
