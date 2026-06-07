import {search} from 'node-emoji';

export interface EmojiMatch {
  emoji: string;
  name: string;
}

/**
 * Search emoji by shortcode/name for the inline `:` picker (offline — node-emoji
 * bundles its dataset). Results are ranked so a name that *starts with* the query
 * comes before a mere substring match, then trimmed to `limit`.
 */
export function searchEmojis(query: string, limit = 8): EmojiMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matches = search(q) as EmojiMatch[];
  return matches
    .slice()
    .sort((a, b) => rank(a.name, q) - rank(b.name, q))
    .slice(0, limit);
}

// 0 = exact, 1 = prefix, 2 = substring (node-emoji only returns matches, so the
// fallthrough is never worse than a substring hit).
function rank(name: string, q: string): number {
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  return 2;
}
