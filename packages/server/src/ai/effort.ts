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
//
// maxSteps = the number of model turns (each a full generate() call) the run
// loop may take before it gives up. Real multi-tool work is a chain of
// DEPENDENT calls the model must serialise — e.g. building a database is
// create_database → describe_database → create_property ×N → create_row ×M,
// which is already >10 turns for a handful of rows. Under the JSON protocol
// that's strictly one tool per turn; even native tool-calling serialises
// dependent calls (each needs the prior result). The prior caps (4/8/16)
// truncated these mid-task with the unhelpful "ran out of steps" reply. Opus
// 4.8 with adaptive thinking plans further ahead per turn, so we raise the caps
// to fit an end-to-end build while keeping a bounded ceiling (a step is a paid
// model turn, so `high` stays finite — 24, not unbounded).
const PROFILES: Record<AiEffort, EffortProfile> = {
  low: {thinkingBudget: 2048, temperature: 0.1, maxTokens: 4000, maxSteps: 6},
  med: {thinkingBudget: 8192, temperature: 0.2, maxTokens: 8000, maxSteps: 12},
  high: {thinkingBudget: 16384, temperature: 0.3, maxTokens: 16000, maxSteps: 24},
};

export const DEFAULT_EFFORT: AiEffort = 'med';

/** Resolve an effort level (defaulting) to its concrete generation profile. */
export function effortProfile(effort: AiEffort | undefined): EffortProfile {
  return PROFILES[effort ?? DEFAULT_EFFORT] ?? PROFILES[DEFAULT_EFFORT];
}
