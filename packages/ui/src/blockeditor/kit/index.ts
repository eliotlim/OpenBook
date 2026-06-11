import {registerCustomBlock, type CustomBlockDef} from '../registry';
import {INPUT_BLOCKS} from './inputs';
import {CHART_BLOCKS} from './charts';
import {CARD_BLOCKS} from './cards';

export {evalExpr, formatValue, inputScope, INPUT_TYPES} from './scope';
export {CHART_KINDS} from './charts';

/**
 * Register the artifact kit: interactive inputs (stepper, text field, radio,
 * checklist, toggle, location, button), live charts, and display blocks
 * (status light, tooltip, link card). Together with the slider + formula
 * these make pages a place to BUILD small interactive artifacts — the kind
 * of throwaway calculator/dashboard/picker an AI would otherwise hand-code —
 * out of reusable, collaborative blocks.
 */
export function registerArtifactKit(): void {
  for (const def of [...INPUT_BLOCKS, ...CHART_BLOCKS, ...CARD_BLOCKS]) {
    registerCustomBlock(def as unknown as CustomBlockDef);
  }
}
