import {useMemo, type CSSProperties} from 'react';
import {Palette} from 'lucide-react';
import {useTheme, useTranslation} from '@/providers';
import {IconButton} from '@/components/ui/icon-button';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {mergeAppearance, type AppearanceOverride} from '@/lib/themes';
import {composePageAppearance, usePageTheme, writePageTheme} from '@/lib/pageTheme';
import {AccentPicker, Field, LevelPicker, NeutralPicker} from './AppearanceControls';

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

/**
 * A small in-page control to give a single page its own accent and style,
 * overriding the app-wide appearance. The sidebar/window chrome is intentionally
 * out of scope — a page override only recolors that page.
 */
export function PageThemeControl({pageId}: {pageId: string}) {
  const {appearance, colorScheme} = useTheme();
  const override = usePageTheme(pageId);
  const {t} = useTranslation();

  const active = !!override && Object.keys(override).length > 0;
  // Effective values drive the selected state; an unset knob shows the app's.
  const eff = mergeAppearance(appearance, override);
  const set = (patch: AppearanceOverride) => writePageTheme(pageId, {...(override ?? {}), ...patch});

  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton
          size="sm"
          aria-label={t('appearance.pageTheme')}
          title={t('appearance.pageTheme')}
          className={active ? 'text-primary hover:text-primary' : undefined}
        >
          <Palette className="h-4 w-4" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex max-h-[70vh] w-80 flex-col gap-4 overflow-y-auto">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold">{t('appearance.pageTheme')}</span>
          {active && (
            <button
              type="button"
              onClick={() => writePageTheme(pageId, null)}
              className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              {t('appearance.matchApp')}
            </button>
          )}
        </div>
        <span className="-mt-2 text-xs text-muted-foreground">{t('appearance.pageThemeHint')}</span>

        <AccentPicker value={eff.themeId} onChange={(themeId) => set({themeId})} scheme={colorScheme} />

        <Field label={t('appearance.interfaceIntensity')}>
          <NeutralPicker value={eff.neutral} onChange={(neutral) => set({neutral})} />
          <div className="mt-1.5">
            <LevelPicker
              value={eff.interfaceIntensity}
              onChange={(interfaceIntensity) => set({interfaceIntensity})}
              labels={[
                t('appearance.levelOff'),
                t('appearance.levelSubtle'),
                t('appearance.levelMedium'),
                t('appearance.levelStrong'),
              ]}
            />
          </div>
        </Field>

        <Field label={t('appearance.controlIntensity')}>
          <LevelPicker
            value={eff.controlIntensity}
            onChange={(controlIntensity) => set({controlIntensity})}
            labels={[
              t('appearance.levelSoft'),
              t('appearance.levelMedium'),
              t('appearance.levelStrong'),
              t('appearance.levelVivid'),
            ]}
          />
        </Field>
      </PopoverContent>
    </Popover>
  );
}
