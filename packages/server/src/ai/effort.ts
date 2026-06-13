import type {AiEffort} from '@open-book/sdk';

/**
 * The single place effort maps to concrete generation knobs. One user-facing
 * dial (low / med / high) expands to a thinking-token budget, sampling
 * temperature, answer-token cap, and the agent's max tool-call steps — so the
 * whole harness scales from "quick and cheap" to "deliberate" without the UI
 * (or the agent loop) hard-coding any of these numbers.
 */
export interface EffortProfile {
  /** Soft cap on reasoning tokens (passed as `thinkingBudget`). */
  thinkingBudget: number;
  /** Sampling temperature for the turn. */
  temperature: number;
  /** Max answer tokens per generation call. */
  maxTokens: number;
  /** Max tool-call rounds the AgentRunner will take. */
  maxSteps: number;
}

const PROFILES: Record<AiEffort, EffortProfile> = {
  low: {thinkingBudget: 256, temperature: 0.1, maxTokens: 600, maxSteps: 4},
  med: {thinkingBudget: 1024, temperature: 0.2, maxTokens: 900, maxSteps: 8},
  high: {thinkingBudget: 4096, temperature: 0.3, maxTokens: 1400, maxSteps: 16},
};

export const DEFAULT_EFFORT: AiEffort = 'med';

/** Resolve an effort level (defaulting) to its concrete generation profile. */
export function effortProfile(effort: AiEffort | undefined): EffortProfile {
  return PROFILES[effort ?? DEFAULT_EFFORT] ?? PROFILES[DEFAULT_EFFORT];
}
