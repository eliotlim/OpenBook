import type {AiEffort} from '@book.dev/sdk';

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

// Budgets are sized for Opus 4.8's extended thinking: every tier clears the
// ≥1024-token floor the Anthropic engine needs to switch thinking on, so
// reasoning is always available and merely scales with effort. maxTokens rises
// in step so a deliberate answer isn't truncated mid-thought.
const PROFILES: Record<AiEffort, EffortProfile> = {
  low: {thinkingBudget: 2048, temperature: 0.1, maxTokens: 4000, maxSteps: 4},
  med: {thinkingBudget: 8192, temperature: 0.2, maxTokens: 8000, maxSteps: 8},
  high: {thinkingBudget: 16384, temperature: 0.3, maxTokens: 16000, maxSteps: 16},
};

export const DEFAULT_EFFORT: AiEffort = 'med';

/** Resolve an effort level (defaulting) to its concrete generation profile. */
export function effortProfile(effort: AiEffort | undefined): EffortProfile {
  return PROFILES[effort ?? DEFAULT_EFFORT] ?? PROFILES[DEFAULT_EFFORT];
}
