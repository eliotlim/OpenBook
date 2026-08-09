import {describe, expect, it} from 'vitest';
// @ts-expect-error -- Vitest runs in Node; the browser package omits Node ambient types.
import {readFileSync} from 'node:fs';
import {themes} from '../themes';

const CSS = readFileSync('src/index.css', 'utf8');
const SCHEMES = ['light', 'dark'] as const;
const SURFACES = ['card', 'background'] as const;

function cssBlock(selector: string): string {
  const start = CSS.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`Missing ${selector} token block in index.css`);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

function cssToken(selector: string, name: string): string {
  const match = cssBlock(selector).match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`Missing --${name} in ${selector}`);
  return match[1].trim();
}

function hslToRgb(triple: string): [number, number, number] {
  const [h, s, l] = triple
    .replace(/%/g, '')
    .trim()
    .split(/\s+/)
    .map(Number)
    .map((value, index) => (index === 0 ? value : value / 100));
  const k = (n: number): number => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((channel) => Math.round(channel * 255)) as [number, number, number];
}

function luminance(triple: string): number {
  const linear = hslToRgb(triple)
    .map((channel) => channel / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('muted foreground contrast', () => {
  it('keeps the CSS base tokens in sync with the default theme', () => {
    const defaultTheme = themes[0];

    for (const scheme of SCHEMES) {
      const selector = scheme === 'light' ? ':root' : '.dark';
      const palette = defaultTheme[scheme];
      expect(cssToken(selector, 'muted-foreground')).toBe(palette.mutedForeground);
      expect(cssToken(selector, 'card')).toBe(palette.card);
      expect(cssToken(selector, 'background')).toBe(palette.background);
    }
  });

  it('keeps muted text at WCAG AA on card and background for every theme and mode', () => {
    for (const theme of themes) {
      for (const scheme of SCHEMES) {
        const palette = theme[scheme];
        for (const surface of SURFACES) {
          const ratio = contrast(palette.mutedForeground, palette[surface]);
          expect(
            ratio,
            `${theme.id}/${scheme}: muted ${palette.mutedForeground} on ${surface} ${palette[surface]}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});
