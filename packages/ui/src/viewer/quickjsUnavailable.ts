import type {EvalBackend, EvalResult} from '../blockeditor/kit/scope';

/**
 * Fail-closed alias that keeps the Worker/WASM implementation out of the
 * standalone viewer. scope.ts selects SBX-3's safe interpreter instead.
 */
export const quickJSEvalBackend: EvalBackend = {
  evaluate(): Promise<EvalResult> {
    return Promise.resolve({error: 'QuickJS evaluation is unavailable in the read-only viewer'});
  },
};
