/**
 * The active data-colour scheme as React context (OB-379).
 *
 * The CSS-var surfaces (tags, dots/swatches, status via `var(--data-*)`) recolour
 * for free when {@link applyDataColors} swaps the variables. But the concrete-hex
 * surfaces — SVG `fill=` presentation attributes (kit + database charts), Leaflet
 * map pins, `<canvas>` — CANNOT read `var()`, so they must resolve
 * `DATA_PALETTE[scheme]` at render. This context threads the active scheme to
 * those React components so they re-render (and repaint) when the user switches
 * Pastel / Vivid / Muted.
 *
 * The default is {@link DEFAULT_DATA_COLOR_SCHEME}, so a provider-less mount (the
 * published-site viewer bundle drives it from `window.__OB_DATA_SCHEME` instead,
 * and exports inline concrete hex directly) renders the pastel default rather
 * than throwing.
 */
import React from 'react';
import {DATA_COLOR_SCHEMES, DEFAULT_DATA_COLOR_SCHEME, type DataColorScheme} from '@book.dev/sdk';

const DataSchemeContext = React.createContext<DataColorScheme>(DEFAULT_DATA_COLOR_SCHEME);

/** Provide the active data-colour scheme to concrete-hex consumers below it. */
export const DataSchemeProvider = DataSchemeContext.Provider;

/** The active data-colour scheme (defaults to pastel outside a provider). */
export const useDataScheme = (): DataColorScheme => React.useContext(DataSchemeContext);

/**
 * The scheme an exported HTML file asked the viewer bundle to paint with —
 * `window.__OB_DATA_SCHEME`, set by the export before the viewer loads (OB-379).
 * Validated (a stray value falls back to pastel). The provider-less viewer reads
 * it to drive both {@link applyDataColors} and the {@link DataSchemeProvider}.
 */
export function readGlobalDataScheme(): DataColorScheme {
  const g = typeof window !== 'undefined' ? (window as {__OB_DATA_SCHEME?: unknown}).__OB_DATA_SCHEME : undefined;
  return typeof g === 'string' && (DATA_COLOR_SCHEMES as readonly string[]).includes(g)
    ? (g as DataColorScheme)
    : DEFAULT_DATA_COLOR_SCHEME;
}
