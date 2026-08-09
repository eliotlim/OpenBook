import {describe, expect, it} from 'vitest';
// @ts-expect-error -- Vitest runs in Node; the browser package omits Node ambient types.
import {readFileSync, readdirSync} from 'node:fs';
import {composeAppearance, DEFAULT_APPEARANCE, PAGE_BACKGROUNDS, themes} from '../themes';

const CSS = readFileSync('src/index.css', 'utf8');
const SCHEMES = ['light', 'dark'] as const;
const INTERFACE_INTENSITIES = [0, 1, 2, 3] as const;
const CONTROL_INTENSITIES = [0, 1, 2, 3] as const;
const BACKGROUNDS = [undefined, ...Object.keys(PAGE_BACKGROUNDS)] as const;
const SURFACES = ['card', 'background', 'popover', 'muted', 'secondary'] as const;
const PLACEHOLDER_SURFACES = ['background', 'card', 'popover'] as const;
const STRONG_SURFACES = ['accent', 'sheet1'] as const;

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

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap(
    (entry: {name: string; isDirectory(): boolean}): string[] => {
      const path = `${directory}/${entry.name}`;
      return entry.isDirectory() ? sourceFiles(path) : [path];
    },
  );
}

describe('muted foreground contrast', () => {
  it('keeps the CSS base tokens in sync with the default theme', () => {
    const defaultTheme = themes[0];

    for (const scheme of SCHEMES) {
      const selector = scheme === 'light' ? ':root' : '.dark';
      const palette = defaultTheme[scheme];
      const strong = cssToken(selector, 'muted-foreground-strong');
      expect(cssToken(selector, 'muted-foreground')).toBe(palette.mutedForeground);
      expect(cssToken(selector, 'card')).toBe(palette.card);
      expect(cssToken(selector, 'background')).toBe(palette.background);
      expect(cssToken(selector, 'popover')).toBe(palette.popover);
      expect(
        contrast(palette.mutedForeground, palette.sheet1),
        `${scheme}: muted ${palette.mutedForeground} on first-paint sheet1 ${palette.sheet1}`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrast(strong, palette.foreground), `${scheme}: strong muted must remain distinct from foreground`).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('keeps muted text at WCAG AA across every composed canvas appearance', () => {
    expect(themes).toHaveLength(17);
    expect(Object.keys(PAGE_BACKGROUNDS)).toHaveLength(8);

    for (const theme of themes) {
      for (const scheme of SCHEMES) {
        for (const interfaceIntensity of INTERFACE_INTENSITIES) {
          for (const background of BACKGROUNDS) {
            const palette = composeAppearance(
              {...DEFAULT_APPEARANCE, themeId: theme.id, interfaceIntensity, background},
              scheme,
            );
            for (const surface of SURFACES) {
              const ratio = contrast(palette.mutedForeground, palette[surface]);
              expect(
                ratio,
                `${theme.id}/${scheme}/interface-${interfaceIntensity}/background-${background ?? 'unset'}: ` +
                  `muted ${palette.mutedForeground} on ${surface} ${palette[surface]}`,
              ).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
      }
    }
  });

  it('keeps placeholder text at WCAG AA across every composed canvas appearance', () => {
    for (const theme of themes) {
      for (const scheme of SCHEMES) {
        const selector = scheme === 'light' ? ':root' : '.dark';
        const placeholder = cssToken(selector, 'placeholder-foreground');
        for (const interfaceIntensity of INTERFACE_INTENSITIES) {
          for (const background of BACKGROUNDS) {
            const palette = composeAppearance(
              {...DEFAULT_APPEARANCE, themeId: theme.id, interfaceIntensity, background},
              scheme,
            );
            for (const surface of PLACEHOLDER_SURFACES) {
              const ratio = contrast(placeholder, palette[surface]);
              expect(
                ratio,
                `${theme.id}/${scheme}/interface-${interfaceIntensity}/background-${background ?? 'unset'}: ` +
                  `placeholder ${placeholder} on ${surface} ${palette[surface]}`,
              ).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
      }
    }
  });

  it('forbids alpha-reduced placeholder color utilities in source', () => {
    const violations = sourceFiles('src')
      .filter((file) => /\.(?:css|js|ts|tsx)$/.test(file))
      .flatMap((file) => {
        const matches = readFileSync(file, 'utf8').match(/placeholder:[^\s'"`]*\/[0-9][^\s'"`]*/g) ?? [];
        return matches.map((utility: string) => `${file}: ${utility}`);
      });

    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('keeps strong muted text at WCAG AA on its accent and sheet-1 binding surfaces', () => {
    for (const theme of themes) {
      for (const scheme of SCHEMES) {
        const selector = scheme === 'light' ? ':root' : '.dark';
        const strong = cssToken(selector, 'muted-foreground-strong');
        for (const interfaceIntensity of INTERFACE_INTENSITIES) {
          for (const controlIntensity of CONTROL_INTENSITIES) {
            for (const background of BACKGROUNDS) {
              const palette = composeAppearance(
                {...DEFAULT_APPEARANCE, themeId: theme.id, interfaceIntensity, controlIntensity, background},
                scheme,
              );
              for (const surface of STRONG_SURFACES) {
                const ratio = contrast(strong, palette[surface]);
                const normalRatio = contrast(palette.mutedForeground, palette[surface]);
                const context =
                  `${theme.id}/${scheme}/interface-${interfaceIntensity}/control-${controlIntensity}/` +
                  `background-${background ?? 'unset'}`;
                expect(
                  ratio,
                  `${context}: strong muted ${strong} on ${surface} ${palette[surface]}`,
                ).toBeGreaterThanOrEqual(4.5);
                // Strong is CSS-only (not in ThemeTokens, so applyAppearance never emits it).
                // Its fixed per-scheme value is safe only while mutedForeground stays
                // theme-invariant: assert the tiers cannot invert if that ever changes.
                expect(
                  ratio,
                  `${context}: strong muted must be more prominent than normal muted on ${surface}`,
                ).toBeGreaterThan(normalRatio);
              }
            }
          }
        }
      }
    }
  });
});
