import type {EvalRequest, EvalResult, SyncEvalBackend} from '../scope';
import {QuickJSEvaluator} from './quickjsVm';

let evaluatorPromise: Promise<QuickJSEvaluator> | undefined;

/** Load the second, in-process VM only when an authoritative save/export asks for it. */
const evaluator = (): Promise<QuickJSEvaluator> => {
  evaluatorPromise ??= QuickJSEvaluator.create();
  return evaluatorPromise;
};

/** In-process sandbox used only by authoritative save/export checkpoints. */
export const quickJSSyncEvalBackend: SyncEvalBackend = {
  prepare(): Promise<void> {
    return evaluator().then(() => undefined);
  },
  evaluate(request: EvalRequest): Promise<EvalResult> {
    return evaluator().then((vm) => vm.evaluateSync(request));
  },
};
