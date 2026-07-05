import {describe, it, expect} from 'vitest';
import {
  DATA_COLOR_TOKENS,
  DATA_PALETTE,
  DATA_STROKE,
  DEFAULT_DATA_COLOR_SCHEME,
  SERIES_ORDER,
  STATUS_TOKENS,
  dataStroke,
  hexAlpha,
  isDataColorToken,
  seriesColor,
  statusColor,
  type DataColorScheme,
} from './dataColors';
import {SELECT_COLORS} from './database';

const HEX = /^#[0-9a-f]{6}$/;
const SCHEMES: DataColorScheme[] = ['pastel', 'vivid', 'muted'];

describe('dataColors canonical palette', () => {
  it('has 12 tokens: the 9 select colours plus 3 chart-only hues', () => {
    expect(DATA_COLOR_TOKENS).toHaveLength(12);
    // The stored select enum stays a strict 9-token subset (no stored-format change).
    for (const c of SELECT_COLORS) expect(DATA_COLOR_TOKENS).toContain(c);
    expect(SELECT_COLORS).toHaveLength(9);
    for (const extra of ['teal', 'cyan', 'indigo']) {
      expect(DATA_COLOR_TOKENS).toContain(extra);
      expect((SELECT_COLORS as readonly string[]).includes(extra)).toBe(false);
    }
  });

  it('cycles a blue-first, 12-long series order of valid tokens', () => {
    expect(SERIES_ORDER).toEqual([
      'blue', 'orange', 'green', 'red', 'purple', 'cyan',
      'yellow', 'teal', 'pink', 'indigo', 'brown', 'gray',
    ]);
    for (const t of SERIES_ORDER) expect(isDataColorToken(t)).toBe(true);
  });

  it('resolves every token × scheme to a hex fill and four chip hexes', () => {
    for (const scheme of SCHEMES) {
      for (const t of DATA_COLOR_TOKENS) {
        const c = DATA_PALETTE[scheme][t];
        expect(c.fill).toMatch(HEX);
        expect(c.chip.light.bg).toMatch(HEX);
        expect(c.chip.light.fg).toMatch(HEX);
        expect(c.chip.dark.bg).toMatch(HEX);
        expect(c.chip.dark.fg).toMatch(HEX);
      }
    }
  });

  it('derives chart series colours by cycling SERIES_ORDER', () => {
    expect(seriesColor(0, 'pastel')).toBe(DATA_PALETTE.pastel.blue.fill);
    expect(seriesColor(0)).toBe(DATA_PALETTE[DEFAULT_DATA_COLOR_SCHEME].blue.fill);
    expect(seriesColor(SERIES_ORDER.length, 'pastel')).toBe(seriesColor(0, 'pastel')); // wraps
    expect(seriesColor(1, 'vivid')).toBe(DATA_PALETTE.vivid.orange.fill);
  });

  it('maps status lamps onto the semantic tokens (ok/warn/bad)', () => {
    expect(STATUS_TOKENS).toEqual({ok: 'green', warn: 'orange', bad: 'red'});
    for (const scheme of SCHEMES) {
      expect(statusColor('ok', scheme)).toBe(DATA_PALETTE[scheme].green.fill);
      expect(statusColor('warn', scheme)).toBe(DATA_PALETTE[scheme].orange.fill);
      expect(statusColor('bad', scheme)).toBe(DATA_PALETTE[scheme].red.fill);
    }
  });

  it('the vivid orange fill shifted to orange-500 (manifest §1.3)', () => {
    expect(DATA_PALETTE.vivid.orange.fill).toBe('#f97316');
    expect(DATA_PALETTE.vivid.green.fill).toBe('#22c55e');
    expect(DATA_PALETTE.pastel.blue.fill).toBe('#93c5fd');
  });

  it('exposes the light-mode hairline (pastel/muted only, not vivid)', () => {
    expect(DATA_STROKE).toBe('rgba(0,0,0,0.12)');
    expect(dataStroke('pastel')).toBe(DATA_STROKE);
    expect(dataStroke('muted')).toBe(DATA_STROKE);
    expect(dataStroke('vivid')).toBe('none');
  });

  it('inlines a hex as rgba at an alpha (for export self-containment)', () => {
    expect(hexAlpha('#86efac', 0.25)).toBe('rgba(134,239,172,0.25)');
    expect(hexAlpha('not-a-hex', 0.5)).toBe('not-a-hex'); // passthrough
  });

  it('guards unknown tokens', () => {
    expect(isDataColorToken('blue')).toBe(true);
    expect(isDataColorToken('cerulean')).toBe(false);
    expect(isDataColorToken(undefined)).toBe(false);
  });
});
