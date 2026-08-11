import {QuickJSEvaluator} from './quickjsVm';
import type {EvalWorkerRequest, EvalWorkerResponse} from './protocol';

interface WorkerScope {
  onmessage: ((event: MessageEvent<EvalWorkerRequest>) => void) | null;
  postMessage(message: EvalWorkerResponse): void;
}

const workerScope = self as unknown as WorkerScope;
const evaluator = QuickJSEvaluator.create();

workerScope.onmessage = (event): void => {
  void evaluator.then((vm) => vm.evaluatePrepared(event.data.request)).then(
    (result) => workerScope.postMessage({id: event.data.id, result}),
    (error: unknown) => workerScope.postMessage({
      id: event.data.id,
      result: {error: error instanceof Error ? error.message : String(error)},
    }),
  );
};
