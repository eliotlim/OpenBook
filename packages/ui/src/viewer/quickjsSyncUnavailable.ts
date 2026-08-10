import type {EvalResult, SyncEvalBackend} from '../blockeditor/kit/scope';

/**
 * The standalone read-only viewer renders through the Worker backend and has
 * no save/export entry point. Keep the in-process export VM out of its IIFE;
 * an accidental authoritative call fails closed instead of evaluating in the
 * host realm.
 */
export const quickJSSyncEvalBackend: SyncEvalBackend = {
  evaluate(): EvalResult {
    return {error: 'Authoritative export evaluation is unavailable in the read-only viewer'};
  },
};
