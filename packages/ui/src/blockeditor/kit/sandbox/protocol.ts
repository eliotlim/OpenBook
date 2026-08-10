import type {EvalRequest, EvalResult} from '../scope';

export interface EvalWorkerRequest {
  id: number;
  request: EvalRequest;
}

export interface EvalWorkerResponse {
  id: number;
  result: EvalResult;
}
