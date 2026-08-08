/**
 * Naming for blocks no renderer can draw — plugin-contributed types (the
 * `{pluginId}/{blockName}` convention) and forward-compatibility unknowns from
 * a newer document version.
 *
 * One source of truth for the words, shared by the in-app fallback
 * ({@link MissingPluginBlock}) and every export surface (interactive HTML,
 * clipboard HTML, Markdown, PDF): a block that reads
 * “Trial balance — this block requires the Ledger plugin” on the page says the
 * same in an exported file, instead of vanishing into an empty paragraph
 * (LX-1). Pure string work — no React, no plugin registry, no DOM — so the
 * export pipeline and the vendored viewer can both call it.
 */

/** `journal-entry` → `Journal entry`; `trialBalance` → `Trial balance`. */
function humanize(name: string): string {
  const words = name
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

export interface UnknownBlockLabel {
  /** `openbook.ledger`, or null when the type is not `{pluginId}/{blockName}`. */
  pluginId: string | null;
  /** `journal-entry`, or null for a non-plugin type. */
  blockName: string | null;
  /** The plugin's display name — `openbook.ledger` → `Ledger`. Null if not a plugin type. */
  pluginLabel: string | null;
  /** The block's display title — `journal-entry` → `Journal entry`. */
  label: string;
  /** One self-contained line explaining why the block isn't rendered here. */
  hint: string;
}

/**
 * Describe an unrenderable block type for display.
 *
 * `pluginName` is the plugin's real manifest name when the caller can resolve
 * it (the app can, via the bundled-plugin registry); without it the name is
 * derived from the id's last dotted segment, which matches the manifest for
 * the reverse-DNS ids plugins actually use (`openbook.ledger` → `Ledger`).
 */
export function describeUnknownBlock(type: string, pluginName?: string): UnknownBlockLabel {
  const raw = (type ?? '').trim();
  const slash = raw.indexOf('/');
  const pluginId = slash > 0 ? raw.slice(0, slash) : null;
  const blockName = slash > 0 ? raw.slice(slash + 1) : null;
  if (pluginId === null) {
    return {
      pluginId: null,
      blockName: null,
      pluginLabel: null,
      // A fabricated first-party-looking title (humanized from an internal id)
      // reading as "unsupported" is worse than a plain, honest label — always
      // say 'Unsupported block'.
      label: 'Unsupported block',
      // The raw type stays in the words: it is the only clue a reader (or a
      // support thread) has about what the block was, and Markdown has no
      // attribute to hide it in.
      hint: raw
        ? `This block (type “${raw}”) isn't supported in exports — open the page in OpenBook to see it.`
        : 'This block isn\'t supported in exports — open the page in OpenBook to see it.',
    };
  }
  const pluginLabel = (pluginName ?? '').trim() || humanize(pluginId.split('.').pop() ?? pluginId) || pluginId;
  return {
    pluginId,
    blockName,
    pluginLabel,
    label: humanize(blockName ?? '') || raw,
    hint: `This block requires the ${pluginLabel} plugin — install the plugin in OpenBook to see it.`,
  };
}
