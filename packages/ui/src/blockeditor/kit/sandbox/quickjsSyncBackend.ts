import type {EvalRequest, EvalResult, SyncEvalBackend} from '../scope';
import {QuickJSEvaluator} from './quickjsVm';

// WASM initialization is asynchronous, but module evaluation waits for it once.
// Every exported API below this module boundary can then evaluate synchronously,
// including the first call to the synchronous export projection.
const evaluator = await QuickJSEvaluator.create();

/** In-process sandbox used only by authoritative save/export checkpoints. */
export const quickJSSyncEvalBackend: SyncEvalBackend = {
  evaluate(request: EvalRequest): EvalResult {
    return evaluator.evaluateSync(request);
  },
};
