import {type ComponentType, type ReactNode} from 'react';
import {CheckIcon} from '@radix-ui/react-icons';
import {cn} from '@/lib/utils';
import {useTranslation} from '@/providers';
import {themes, type AccentGroup, type Level} from '@/lib/themes';
import type {TKey} from '@/i18n';

/** A compact segmented button row — the shared shape for every appearance knob. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  className,
}: {
  options: Array<{value: T; label: string; icon?: ComponentType<{className?: string}>}>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex gap-1.5', className)}>
      {options.map(({value: v, label, icon: Icon}) => (
        <button
          key={String(v)}
          type="button"
          onClick={() => onChange(v)}
          className={cn(
            'flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-2.5 py-2 text-sm transition-colors',
            v === value ? 'border-primary bg-accent' : 'border-border hover:bg-hover',
          )}
        >
          {Icon && <Icon className="h-4 w-4" />}
          <span className="truncate">{label}</span>
        </button>
      ))}
    </div>
  );
}

/** A labelled section wrapper used throughout the appearance UI. */
export function Field({label, hint, children}: {label: string; hint?: string; children: ReactNode}) {
  return (
    <section className="flex flex-col gap-2">
      <span className="text-sm font-medium">{label}</span>
      {hint && <span className="-mt-1 text-xs text-muted-foreground">{hint}</span>}
      {children}
    </section>
  );
}

const GROUP_LABEL: Record<AccentGroup, TKey> = {
  gray: 'appearance.accentGray',
  bold: 'appearance.accentBold',
  pastel: 'appearance.accentPastel',
};
const GROUP_ORDER: AccentGroup[] = ['gray', 'bold', 'pastel'];

/** The accent-palette picker: swatches grouped by bold / pastel / neutral. */
export function AccentPicker({
  value,
  onChange,
  scheme,
}: {
  value: string;
  onChange: (id: string) => void;
  scheme: 'light' | 'dark';
}) {
  const {t} = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      {GROUP_ORDER.map((group) => {
        const group_themes = themes.filter((th) => (th.group ?? 'bold') === group);
        if (group_themes.length === 0) return null;
        return (
          <div key={group} className="flex flex-col gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
              {t(GROUP_LABEL[group])}
            </span>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {group_themes.map((theme) => {
                const tokens = scheme === 'dark' ? theme.dark : theme.light;
                const active = theme.id === value;
                return (
                  <button
                    key={theme.id}
                    type="button"
                    onClick={() => onChange(theme.id)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-sm transition-colors',
                      active ? 'border-primary bg-accent' : 'border-border hover:bg-hover',
                    )}
                  >
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border"
                      style={{backgroundColor: `hsl(${tokens.primary})`}}
                    >
                      {active && (
                        <CheckIcon
                          className="h-3.5 w-3.5"
                          style={{color: `hsl(${tokens.primaryForeground})`}}
                        />
                      )}
                    </span>
                    <span className="truncate">{t(theme.nameKey as TKey)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A 0–3 level picker (interface intensity / control intensity). */
export function LevelPicker({
  value,
  onChange,
  labels,
}: {
  value: Level;
  onChange: (v: Level) => void;
  labels: [string, string, string, string];
}) {
  const opts = labels.map((label, i) => ({value: i as Level, label}));
  return <Segmented options={opts} value={value} onChange={onChange} />;
}
