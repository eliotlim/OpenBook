import {type ReactNode} from 'react';
import {Switch} from '@/components/ui/switch';
import {useTranslation} from '@/providers';
import type {TKey} from '@/i18n';
import {cn} from '@/lib/utils';

/** Where a setting takes effect: only this browser/device, the whole workspace
 *  (server-side, shared by everyone), or your account across devices. */
export type SettingsScope = 'device' | 'workspace' | 'account';

const SCOPE_LABEL: Record<SettingsScope, TKey> = {
  device: 'settings.scope.device',
  workspace: 'settings.scope.workspace',
  account: 'settings.scope.account',
};

/** A small muted pill naming where a setting applies (device / workspace /
 *  account). Used under a screen title, and inline to flag an exception. */
export function ScopeChip({scope, className}: {scope: SettingsScope; className?: string}) {
  const {t} = useTranslation();
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground',
        className,
      )}
    >
      {t(SCOPE_LABEL[scope])}
    </span>
  );
}

/**
 * Shared layout for a settings sub-screen: a title, an optional lead paragraph,
 * and a vertical stack of sections. Every screen opens with this so headings and
 * spacing stay identical instead of each panel re-deriving them inline.
 */
export function SettingsScreen({
  title,
  description,
  scope,
  children,
}: {
  title: string;
  description?: string;
  /** Renders a muted scope chip under the title. */
  scope?: SettingsScope;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold">{title}</h3>
        {scope && <ScopeChip scope={scope} className="mt-1" />}
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {children}
    </div>
  );
}

/** A labelled group within a screen — an optional heading + hint, then content. */
export function SettingsSection({
  title,
  description,
  children,
  className,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      {title && <h4 className="text-sm font-semibold">{title}</h4>}
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      {children}
    </section>
  );
}

/** A stacked label + hint + control, for inputs / selects / textareas. */
export function SettingsField({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
      </label>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      <div className="mt-1">{children}</div>
    </div>
  );
}

/** A horizontal row — label + hint on the left, a Switch on the right. */
export function SettingsToggle({
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex items-center justify-between gap-6 rounded-md border border-border px-3.5 py-3',
        disabled && 'opacity-60',
      )}
    >
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </label>
  );
}
