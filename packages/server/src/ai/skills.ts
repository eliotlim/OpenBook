import type {AiSkill} from '@open-book/sdk';
import type {Db} from '../db';

/**
 * Prompt/recipe skills: user-authored markdown (name + description +
 * instructions) the agent lists in its system-prompt catalogue and can inline
 * when invoked. No code — pure prompt engineering, editable by the user.
 *
 * Storage decision: a single row in the existing `settings` table under the
 * key `ai.skills` (a JSON array of {@link AiSkill}). This needs no schema
 * migration, travels with the workspace like the AI config, and matches the
 * scale (a handful of skills per workspace). A dedicated table would be
 * overkill for prompt snippets and would couple skills to a migration.
 */

const SETTINGS_KEY = 'ai.skills';
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Normalize a free-text name into a slug ("My Recipe" → "my-recipe"). */
export function slugifySkillName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export class SkillStore {
  constructor(private readonly db: Db) {}

  async list(): Promise<AiSkill[]> {
    const rows = await this.db.query<{value: AiSkill[]}>(
      'SELECT value FROM settings WHERE key = $1',
      [SETTINGS_KEY],
    );
    const value = rows[0]?.value;
    return Array.isArray(value) ? value.filter((s) => s && typeof s.name === 'string') : [];
  }

  /** Create or replace a skill (keyed on its slug). Returns the stored skill. */
  async upsert(input: AiSkill): Promise<AiSkill> {
    const name = slugifySkillName(input.name);
    if (!NAME_RE.test(name)) throw new Error('A skill needs a name (letters/numbers).');
    const skill: AiSkill = {
      name,
      description: String(input.description ?? '').slice(0, 280),
      instructions: String(input.instructions ?? ''),
      updatedAt: new Date().toISOString(),
    };
    const all = await this.list();
    const next = [...all.filter((s) => s.name !== name), skill].sort((a, b) => a.name.localeCompare(b.name));
    await this.save(next);
    return skill;
  }

  /** Remove a skill by slug. Returns true if one was removed. */
  async remove(name: string): Promise<boolean> {
    const slug = slugifySkillName(name);
    const all = await this.list();
    const next = all.filter((s) => s.name !== slug);
    if (next.length === all.length) return false;
    await this.save(next);
    return true;
  }

  /** Resolve a set of skill names to their instruction bodies (in order). */
  async resolve(names: string[]): Promise<AiSkill[]> {
    if (names.length === 0) return [];
    const byName = new Map((await this.list()).map((s) => [s.name, s]));
    return names.map((n) => byName.get(slugifySkillName(n))).filter((s): s is AiSkill => Boolean(s));
  }

  private async save(skills: AiSkill[]): Promise<void> {
    await this.db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [SETTINGS_KEY, JSON.stringify(skills)],
    );
  }
}
