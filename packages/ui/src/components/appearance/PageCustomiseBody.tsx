import {Image as ImageIcon, Trash2} from 'lucide-react';
import {useEffect, useMemo, useState, type CSSProperties} from 'react';
import {useTheme, useTranslation} from '@/providers';
import {cn} from '@/lib/utils';
import {getTheme, mergeAppearance, PAGE_BACKGROUNDS, type AppearanceOverride} from '@/lib/themes';
import {composePageAppearance, hasPageTheme, usePageTheme, writePageTheme} from '@/lib/pageTheme';
import {FONT_PRESETS, readPageFonts, usePageFonts, writePageFonts, type PageFonts} from '@/lib/pageFont';
import {PAGE_THEME_PRESETS, type PageThemePreset} from '@/lib/pageThemePresets';
import {getPageCustomiseTarget, subscribePageCustomise} from '@/lib/pageCustomise';
import {usePageCover, writePageCover} from '@/lib/pageCover';
import {CoverPicker} from '@/components/PageCover';
import {AccentPicker, Field, LevelPicker, Segmented} from './AppearanceControls';

/**
 * Compose this page's effective appearance (the app's appearance with the
 * page's override merged on top) into a scoped CSS-variable `style`, or
 * `undefined` when the page just follows the app. Spread onto the page wrapper
 * so the override recolors the page content while the app chrome stays global.
 */
export function usePageThemeStyle(pageId: string): CSSProperties | undefined {
  const {appearance, colorScheme} = useTheme();
  const override = usePageTheme(pageId);
  return useMemo(
    () => composePageAppearance(appearance, override, colorScheme) as CSSProperties | undefined,
    [appearance, override, colorScheme],
  );
}

/** Whether a page sets its own canvas background tint (drives `.ob-page-bg`). */
export function usePageHasBackground(pageId: string): boolean {
  const override = usePageTheme(pageId);
  return !!override?.background;
}

const CUSTOM = '__custom__';

/** Soft full-canvas background swatches (per-page). A leading tile clears it. */
function BackgroundPicker({
  value,
  scheme,
  onChange,
}: {
  value: string | undefined;
  scheme: 'light' | 'dark';
  onChange: (token: string | undefined) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        title="Default"
        aria-label="Default background"
        onClick={() => onChange(undefined)}
        className={cn(
          'h-7 w-7 rounded-md border bg-card',
          !value ? 'border-primary ring-2 ring-ring' : 'border-border',
        )}
        style={{backgroundImage: 'repeating-linear-gradient(45deg, transparent, transparent 4px, hsl(var(--border)) 4px, hsl(var(--border)) 5px)'}}
      />
      {Object.keys(PAGE_BACKGROUNDS).map((token) => (
        <button
          key={token}
          type="button"
          title={token}
          aria-label={`Background ${token}`}
          onClick={() => onChange(token)}
          className={cn('h-7 w-7 rounded-md border', value === token ? 'border-primary ring-2 ring-ring' : 'border-border')}
          style={{backgroundColor: `hsl(${PAGE_BACKGROUNDS[token][scheme]})`}}
        />
      ))}
    </div>
  );
}

/** The page's cover, set right from the customisation pane. */
function CoverField({pageId}: {pageId: string}) {
  const cover = usePageCover(pageId);
  const preview =
    cover?.kind === 'gradient'
      ? {background: cover.css}
      : cover?.kind === 'image'
        ? {backgroundImage: `url("${cover.url}")`, backgroundSize: 'cover', backgroundPosition: '50% 50%'}
        : undefined;
  return (
    <div className="flex items-center gap-2">
      <div className="h-9 w-16 shrink-0 overflow-hidden rounded-md border border-border bg-muted" style={preview} aria-hidden />
      <CoverPicker pageId={pageId}>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1.5 text-sm transition-colors hover:bg-hover"
        >
          <ImageIcon className="h-3.5 w-3.5" />
          {cover ? 'Change' : 'Add cover'}
        </button>
      </CoverPicker>
      {cover && (
        <button
          type="button"
          onClick={() => writePageCover(pageId, null)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove
        </button>
      )}
    </div>
  );
}

/** A typeface picker: the built-in presets plus a free-text custom family. */
function TypefacePicker({value, onChange}: {value: string | undefined; onChange: (v: string | undefined) => void}) {
  const {t} = useTranslation();
  const isCustom = !!value && !FONT_PRESETS.some((p) => p.id === value);
  const selected = isCustom ? CUSTOM : value ?? 'sans';
  const options = [
    ...FONT_PRESETS.map((p) => ({value: p.id as string, label: t(p.labelKey as Parameters<typeof t>[0])})),
    {value: CUSTOM, label: t('appearance.fontCustom')},
  ];
  return (
    <div className="flex flex-col gap-1.5">
      <Segmented
        options={options}
        value={selected}
        onChange={(v) => (v === CUSTOM ? onChange(isCustom ? value : '') : onChange(v))}
      />
      {selected === CUSTOM && (
        <input
          value={isCustom ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('appearance.fontCustomPlaceholder')}
          aria-label={t('appearance.fontCustom')}
          spellCheck={false}
          className="w-full rounded-md border border-border bg-card px-2 py-1.5 text-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        />
      )}
    </div>
  );
}

/**
 * Whole-page theme presets (#4): each tile sets the accent, background, fonts,
 * and cover together in one click — a coordinated look you then refine with the
 * per-aspect pickers below. The tile previews the cover (or an accent wash) plus
 * the accent dot.
 */
function PresetPicker({pageId, scheme}: {pageId: string; scheme: 'light' | 'dark'}) {
  const {t} = useTranslation();
  const apply = (preset: PageThemePreset): void => {
    writePageTheme(pageId, preset.override); // an empty override clears (= follow app)
    writePageFonts(pageId, preset.fonts);
    writePageCover(pageId, preset.cover);
  };
  return (
    <div className="grid grid-cols-3 gap-2">
      {PAGE_THEME_PRESETS.map((preset) => {
        const accent = getTheme(preset.override.themeId ?? 'default');
        const swatch = (scheme === 'dark' ? accent.dark : accent.light).primary;
        const wash = preset.cover?.kind === 'gradient' ? preset.cover.css : `hsl(${swatch} / 0.14)`;
        return (
          <button
            key={preset.id}
            type="button"
            onClick={() => apply(preset)}
            className="flex cursor-pointer flex-col gap-1.5 rounded-md border border-border p-1.5 text-xs transition-colors hover:bg-hover"
          >
            <span className="h-8 w-full rounded" style={{background: wash}} aria-hidden />
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 shrink-0 rounded-full border border-border" style={{backgroundColor: `hsl(${swatch})`}} aria-hidden />
              <span className="truncate">{t(preset.labelKey as Parameters<typeof t>[0])}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Per-page customisation. A whole-page theme preset (#4) sets control colour,
 * font, background, and cover at once; the individual pickers (#5) then tweak
 * each aspect. Writes page-scoped overrides (theme via {@link writePageTheme},
 * fonts via {@link writePageFonts}, cover via {@link writePageCover}); the app
 * chrome is out of scope — a page override only restyles that page.
 */
export function PageAppearanceControls({pageId}: {pageId: string}) {
  const {appearance, colorScheme} = useTheme();
  const override = usePageTheme(pageId);
  const fonts = usePageFonts(pageId);
  const {t} = useTranslation();

  const active = (!!override && Object.keys(override).length > 0) || !!fonts;
  const eff = mergeAppearance(appearance, override);
  const setTheme = (patch: AppearanceOverride) => writePageTheme(pageId, {...(override ?? {}), ...patch});
  const setBackground = (token: string | undefined): void => {
    const next = {...(override ?? {})};
    if (token) next.background = token;
    else delete next.background;
    writePageTheme(pageId, next);
  };
  const setFont = (patch: PageFonts) => {
    const next = {...(readPageFonts(pageId) ?? {}), ...patch};
    writePageFonts(pageId, {body: next.body || undefined, heading: next.heading || undefined});
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{t('appearance.pageThemeHint')}</span>
        {active && (
          <button
            type="button"
            onClick={() => {
              writePageTheme(pageId, null);
              writePageFonts(pageId, null);
              writePageCover(pageId, null);
            }}
            className="shrink-0 cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('appearance.matchApp')}
          </button>
        )}
      </div>

      <Field label={t('appearance.presets')} hint={t('appearance.presetsHint')}>
        <PresetPicker pageId={pageId} scheme={colorScheme} />
      </Field>

      <Field label={t('appearance.controlColor')} hint={t('appearance.controlColorHint')}>
        <AccentPicker value={eff.themeId} onChange={(themeId) => setTheme({themeId})} scheme={colorScheme} />
        <div className="mt-1.5">
          <LevelPicker
            value={eff.controlIntensity}
            onChange={(controlIntensity) => setTheme({controlIntensity})}
            labels={[
              t('appearance.levelSoft'),
              t('appearance.levelMedium'),
              t('appearance.levelStrong'),
              t('appearance.levelVivid'),
            ]}
          />
        </div>
      </Field>

      <Field label={t('appearance.background')} hint={t('appearance.backgroundHint')}>
        <BackgroundPicker value={override?.background} scheme={colorScheme} onChange={setBackground} />
      </Field>

      <Field label={t('appearance.fontBody')} hint={t('appearance.fontBodyHint')}>
        <TypefacePicker value={fonts?.body} onChange={(body) => setFont({body})} />
      </Field>

      <Field label={t('appearance.fontHeading')} hint={t('appearance.fontHeadingHint')}>
        <TypefacePicker value={fonts?.heading} onChange={(heading) => setFont({heading})} />
      </Field>

      <Field label={t('appearance.cover')} hint={t('appearance.coverHint')}>
        <CoverField pageId={pageId} />
      </Field>
    </div>
  );
}

/**
 * The page-customisation side pane body (the {@link CUSTOMISE_PANE_ID} pane).
 * Reads the page being customised from the `pageCustomise` bridge and renders
 * its appearance + typeface controls — the same side-pane mechanism the block
 * settings use, rather than a cramped popover.
 */
export function PageCustomiseBody() {
  const {t} = useTranslation();
  const [pageId, setPageId] = useState<string | null>(getPageCustomiseTarget());
  useEffect(() => subscribePageCustomise(() => setPageId(getPageCustomiseTarget())), []);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-4 py-2.5">
        <p className="truncate text-sm font-semibold">{t('appearance.pageTheme')}</p>
        <p className="text-xs text-muted-foreground">{t('appearance.pageCustomiseSubtitle')}</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {pageId ? (
          <PageAppearanceControls pageId={pageId} />
        ) : (
          <p className="text-xs text-muted-foreground">{t('appearance.pageCustomiseEmpty')}</p>
        )}
      </div>
    </div>
  );
}

/** Whether a page carries any per-page customisation (theme knob or font). */
export const hasPageCustomisation = (pageId: string): boolean => hasPageTheme(pageId) || !!readPageFonts(pageId);
