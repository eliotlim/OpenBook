import * as Y from 'yjs';
import {IDENTITY_COLORS} from '@book.dev/sdk';
import type {AwarenessSelection, AwarenessState} from '@/blockeditor';

/**
 * Pure derivations for the multiplayer presence surface (Collab T5): turning the
 * raw `y-protocols/awareness` state map into the peer list the avatar stack and
 * remote-cursor overlay render, and resolving a peer's `Y.RelativePosition`
 * selection back to absolute character offsets. Kept free of React/DOM so both can
 * be unit-tested without a layout engine (the cursor *rendering* itself — DOM rects
 * in a contenteditable — is verified manually / in e2e, see RemoteCursors).
 */

/** A readable near-black foreground (vs white) for a coloured presence swatch. */
const NEAR_BLACK = '#111827';

/** The WCAG relative luminance of a `#rrggbb` colour (0 = black, 1 = white). */
function relativeLuminance(hex: string): number {
  const m = hex.replace('#', '');
  const channel = (i: number): number => {
    const c = parseInt(m.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

const contrastRatio = (a: number, b: number): number => {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * The legible foreground (white or a near-black) for text on a solid presence
 * swatch — picked per-swatch by luminance. The 8 {@link IDENTITY_COLORS} keep
 * their solid fill (so a peer's avatar, caret and label read as one identity), but
 * white text fails WCAG AA on the lighter swatches (amber/teal/green ≈ 2.2–2.9:1);
 * choosing the higher-contrast foreground lifts every swatch past AA (≥5:1 here)
 * for the small bold avatar initials and the cursor name label.
 */
export function readableTextColor(background: string): string {
  const bg = relativeLuminance(background);
  const onWhite = contrastRatio(bg, relativeLuminance('#ffffff'));
  const onBlack = contrastRatio(bg, relativeLuminance(NEAR_BLACK));
  return onBlack >= onWhite ? NEAR_BLACK : '#ffffff';
}

/** One present peer, projected from an awareness state entry. */
export interface PeerPresence {
  /** The awareness client id (one per open tab/connection). */
  clientId: number;
  /** Stable identity seed (the server-stamped principal subject). */
  id: string;
  /** Display name (server-stamped for network peers, so trustworthy). */
  name: string;
  /** Presence colour (hex from {@link IDENTITY_COLORS}). */
  color: string;
  /** The peer's live selection, or null when they have no caret here. */
  selection: AwarenessSelection | null;
}

export interface PresencePeersOptions {
  /** Collapse multiple connections of the SAME identity into one (avatar stack).
   *  Off for the cursor layer, where each tab gets its own caret. Default true. */
  dedupe?: boolean;
}

/**
 * Project an awareness state map into the present peers, excluding the local
 * client. With `dedupe` (the default), one entry per distinct identity — so a user
 * with two tabs open shows a single avatar. Sorted by name then id so the avatar
 * order is stable across re-renders (no flicker as states churn).
 */
export function presencePeers(
  states: Map<number, AwarenessState>,
  localClientId: number,
  {dedupe = true}: PresencePeersOptions = {},
): PeerPresence[] {
  const out: PeerPresence[] = [];
  const seen = new Set<string>();
  for (const [clientId, state] of states) {
    if (clientId === localClientId) continue;
    const user = state?.user;
    if (!user || !user.id) continue; // a half-initialised peer (no identity yet)
    if (dedupe && seen.has(user.id)) continue;
    seen.add(user.id);
    out.push({
      clientId,
      id: user.id,
      name: (user.name || '').trim() || 'Someone',
      color: user.color || IDENTITY_COLORS[0],
      selection: state.selection ?? null,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return out;
}

/**
 * Resolve a peer's selection (carried as `Y.RelativePosition` JSON so it survives
 * concurrent edits) back to absolute character offsets within its block's text —
 * the round-trip T4's tests pinned. Returns null when there's no caret (block-level
 * focus only) or the position no longer resolves (its block was deleted), so the
 * caller simply draws nothing rather than crashing. `anchor === head` ⇒ a collapsed
 * caret; otherwise the inclusive range to highlight.
 */
export function resolveSelectionIndices(
  doc: Y.Doc,
  sel: AwarenessSelection | null | undefined,
): {anchor: number; head: number} | null {
  if (!sel || sel.anchor == null) return null;
  try {
    const anchorRel = Y.createRelativePositionFromJSON(sel.anchor);
    const headRel = sel.head == null ? anchorRel : Y.createRelativePositionFromJSON(sel.head);
    const anchorAbs = Y.createAbsolutePositionFromRelativePosition(anchorRel, doc);
    const headAbs = Y.createAbsolutePositionFromRelativePosition(headRel, doc);
    if (!anchorAbs || !headAbs) return null;
    return {anchor: anchorAbs.index, head: headAbs.index};
  } catch {
    // A malformed/foreign relative position — ignore rather than break the layer.
    return null;
  }
}
