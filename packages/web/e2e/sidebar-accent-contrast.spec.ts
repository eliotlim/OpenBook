/**
 * OB-377 guard: the OPT-IN full-accent sidebar must render legible text/icons on
 * the saturated surface — verified on the REAL DOM (getComputedStyle color +
 * effective background → WCAG contrast), not idealized token math. Covers the
 * top nav, section headers, favourites, page tree (+ chevrons/icons), the
 * OnboardingNudge card, and the workspace switcher, across default / ocean
 * (bold) / graphite (gray) accents in light AND dark. Bar: text ≥ 4.5:1, icons
 * ≥ 3:1.
 */
import {test, expect} from './fixtures';

const THEMES = ['default', 'ocean', 'graphite'] as const;
const MODES = ['light', 'dark'] as const;
const PAGE_NAMES = ['Product roadmap', 'Meeting notes', 'Design ideas'];

let ids: string[] = [];

test.beforeAll(async ({dataServer}) => {
  const bundle = (await (await fetch(`${dataServer}/api/export`)).json()) as {pages?: {id: string; name: string | null}[]};
  await Promise.all(
    (bundle.pages ?? [])
      .filter((p) => p.name && PAGE_NAMES.includes(p.name))
      .map((p) => fetch(`${dataServer}/api/pages/${p.id}`, {method: 'DELETE'}).catch(() => undefined)),
  );
  ids = [];
  for (const name of PAGE_NAMES) {
    const res = await fetch(`${dataServer}/api/pages`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({name, data: {editorjs: {blocks: []}, values: [], names: []}}),
    });
    ids.push(((await res.json()) as {id: string}).id);
  }
});

// Runs in the browser: audit every visible sidebar text/icon element.
function auditSidebar() {
  const drawer = [...document.querySelectorAll<HTMLElement>('.ob-accent-chrome')].find((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 100 && r.height > 100; // the sidebar Drawer, not the 0-height titlebar
  });
  if (!drawer) return {error: 'no sidebar found'} as const;

  // Normalise ANY CSS colour string (rgb/hsl/oklch/hex/named, incl. alpha) to
  // straight [r,g,b,a] via a 1×1 canvas — getComputedStyle can return oklch()
  // for the Tailwind v4 palette (e.g. the avatar), which a plain rgb() regex
  // would drop to transparent and mis-measure.
  const cx = document.createElement('canvas').getContext('2d')!;
  const parse = (c: string): [number, number, number, number] => {
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = '#000';
    cx.fillStyle = c;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (fg: [number, number, number, number], bg: [number, number, number]): [number, number, number] => {
    const a = fg[3];
    return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)) as unknown as [number, number, number];
  };
  const effectiveBg = (el: HTMLElement): [number, number, number] => {
    const layers: Array<[number, number, number, number]> = [];
    let e: HTMLElement | null = el;
    while (e) {
      const bg = parse(getComputedStyle(e).backgroundColor);
      if (bg[3] > 0) layers.push(bg);
      if (bg[3] >= 0.999) break;
      e = e.parentElement;
    }
    let result: [number, number, number] = layers.length ? [layers[layers.length - 1][0], layers[layers.length - 1][1], layers[layers.length - 1][2]] : [255, 255, 255];
    for (let i = layers.length - 2; i >= 0; i--) result = over(layers[i], result);
    return result;
  };
  const lum = ([r, g, b]: [number, number, number]): number => {
    const f = (c: number): number => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a: [number, number, number], b: [number, number, number]): number => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };

  const items: Array<{kind: 'text' | 'icon'; label: string; ratio: number}> = [];
  for (const el of drawer.querySelectorAll<HTMLElement>('*')) {
    const isIcon = el.tagName.toLowerCase() === 'svg';
    const directText = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent ?? '').trim())
      .join('');
    const isText = /[a-zA-Z]/.test(directText); // skip emoji/symbol-only glyphs
    if (!isIcon && !isText) continue;
    // Skip the account monogram: an aria-hidden decorative identity badge with
    // its own hue background (WCAG-exempt); the real identity is the adjacent
    // visible name, which IS measured.
    if (el.closest('[data-avatar-kind]')) continue;
    if (!el.checkVisibility({opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true})) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const bg = effectiveBg(el);
    const fg = over(parse(getComputedStyle(el).color), bg);
    items.push({
      kind: isIcon ? 'icon' : 'text',
      label: isIcon ? `<svg> ${(el.getAttribute('aria-label') ?? el.closest('[aria-label]')?.getAttribute('aria-label') ?? '').slice(0, 24)}` : directText.slice(0, 28),
      ratio: Math.round(contrast(fg, bg) * 100) / 100,
    });
  }
  const sheet = getComputedStyle(drawer).backgroundColor;
  const text = items.filter((i) => i.kind === 'text');
  const icon = items.filter((i) => i.kind === 'icon');
  const worst = (arr: typeof items) => arr.reduce((w, i) => (i.ratio < w.ratio ? i : w), arr[0] ?? {ratio: 99, label: '(none)', kind: 'text' as const});
  return {sheet, count: items.length, worstText: worst(text), worstIcon: worst(icon), fails: items.filter((i) => i.ratio < (i.kind === 'text' ? 4.5 : 3))};
}

for (const themeId of THEMES) {
  for (const mode of MODES) {
    test(`accent sidebar is legible on real DOM — ${themeId} / ${mode}`, async ({page, context}) => {
      await context.addInitScript(
        ({themeId, mode, favs}) => {
          localStorage.setItem('theme', mode);
          localStorage.setItem('openbook.favorites', JSON.stringify(favs));
          localStorage.setItem(
            'openbook.appearance',
            JSON.stringify({themeId, sidebar: 'accent', interfaceIntensity: 2, controlIntensity: 2}),
          );
        },
        {themeId, mode, favs: [ids[0], ids[1]]},
      );
      await page.setViewportSize({width: 1280, height: 860});
      await page.goto('/');
      await expect(page.getByText(PAGE_NAMES[0]).first()).toBeVisible({timeout: 20_000});
      await page.waitForTimeout(500); // appearance apply settles

      const a = await page.evaluate(auditSidebar);
      expect(a, 'sidebar audit').not.toHaveProperty('error');
      if ('error' in a) return;

      // Report the real numbers for the run log.
      console.log(
        `[accent-contrast] ${themeId}/${mode}: sheet=${a.sheet} n=${a.count} ` +
          `worstText=${a.worstText.ratio} ("${a.worstText.label}") worstIcon=${a.worstIcon.ratio} ("${a.worstIcon.label}")`,
      );
      if (a.fails.length) {
        console.log(`[accent-contrast] FAILURES ${themeId}/${mode}:`, JSON.stringify(a.fails, null, 2));
      }

      expect(a.worstText.ratio, `worst text on ${themeId}/${mode} ("${a.worstText.label}")`).toBeGreaterThanOrEqual(4.5);
      expect(a.worstIcon.ratio, `worst icon on ${themeId}/${mode} ("${a.worstIcon.label}")`).toBeGreaterThanOrEqual(3);
    });
  }
}
