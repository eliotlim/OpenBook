/**
 * Per-feature surfacing for AI entry points. Not everyone wants AI front and
 * centre, so each AI feature can be set to:
 *   - `recommended` — shown up front in menus (the default),
 *   - `enabled`     — present but only surfaced once the user searches for it,
 *   - `disabled`    — removed from menus entirely.
 *
 * The setting lives in the user preferences blob (see {@link
 * providers/PreferencesProvider}); menus read it through {@link
 * readFeatureVisibility}, which works outside React too (the block editor mounts
 * its own root), mirroring how favourites/recents read localStorage directly.
 */

import type {TKey} from '@/i18n';

export type FeatureVisibility = 'recommended' | 'enabled' | 'disabled';

/** An AI entry point the user can dial up or down. `id` matches the command /
 *  slash-item id so each surface gates the right item. */
export interface AiFeatureDef {
  id: string;
  /** i18n key for the label shown in Settings → AI → Features. */
  labelKey: TKey;
}

export const AI_FEATURES: AiFeatureDef[] = [
  {id: 'ask-assistant', labelKey: 'ai.feature.assistant'},
  {id: 'ai-search', labelKey: 'ai.feature.search'},
  {id: 'ai-continue', labelKey: 'ai.feature.continue'},
  {id: 'ai-tasks', labelKey: 'ai.feature.tasks'},
];

const AI_FEATURE_IDS = new Set(AI_FEATURES.map((f) => f.id));

export const isAiFeature = (id: string): boolean => AI_FEATURE_IDS.has(id);

export const DEFAULT_FEATURE_VISIBILITY: FeatureVisibility = 'recommended';

// Kept in sync with PREFERENCES_STORAGE_KEY in providers/PreferencesProvider —
// inlined so this module (read by the editor) needn't import the React provider.
const PREFERENCES_KEY = 'openbook.preferences';

/** A feature's visibility, read straight from persisted preferences (defaults
 *  to `recommended`). Safe to call outside React and during SSR. */
export function readFeatureVisibility(id: string): FeatureVisibility {
  try {
    if (typeof localStorage === 'undefined') return DEFAULT_FEATURE_VISIBILITY;
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return DEFAULT_FEATURE_VISIBILITY;
    const features = (JSON.parse(raw) as {features?: Record<string, FeatureVisibility>}).features;
    return features?.[id] ?? DEFAULT_FEATURE_VISIBILITY;
  } catch {
    return DEFAULT_FEATURE_VISIBILITY;
  }
}

/** Whether an item with this visibility shows, given whether the user is
 *  searching: recommended → always; enabled → only while searching; disabled →
 *  never. */
export function featureShown(vis: FeatureVisibility, searching: boolean): boolean {
  if (vis === 'disabled') return false;
  if (vis === 'enabled') return searching;
  return true;
}
