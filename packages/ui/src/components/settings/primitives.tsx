import {type ComponentType, type ReactNode} from 'react';
import {Switch} from '@/components/ui/switch';
import {cn} from '@/lib/utils';

/**
 * Shared layout for a settings sub-screen: a title, an optional lead paragraph,
 * and a vertical stack of sections. Every screen opens with this so headings and
 * spacing stay identical instead of each panel re-deriving them inline.
 */
export function SettingsScreen({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-7">
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold">{title}</h3>
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

/**
 * A placeholder for a sub-screen whose backend doesn't exist yet (the app is
 * local-first — no accounts / payments / integrations). A calm, centered icon +
 * copy, with an optional call to action, rather than a broken-looking empty tab.
 */
export function SettingsStub({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: ComponentType<{className?: string}>;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center gap-3 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="h-6 w-6" />
      </span>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
