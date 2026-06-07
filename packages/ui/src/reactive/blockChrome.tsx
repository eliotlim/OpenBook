import React from 'react';
import {cn} from '@/lib/utils';

/**
 * The shared shell for reactive blocks (expr / chart / slider): one calm,
 * token-driven card that lifts its border on focus. Defined once so every
 * reactive block looks identical instead of re-deriving the panel inline.
 */
export const ReactiveCard: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({className, ...props}) => (
  <div
    className={cn(
      'reactive-block rounded-lg border border-border bg-muted/30 px-3.5 py-3 transition-colors focus-within:border-ring/60',
      className,
    )}
    {...props}
  />
);

/** An inline labelled control (the `name`, `min`, `max`… rows in block headers). */
export const FieldRow: React.FC<{label: string; children: React.ReactNode; className?: string}> = ({
  label,
  children,
  className,
}) => (
  <label className={cn('inline-flex items-center gap-1.5', className)}>
    <span className="select-none text-muted-foreground/70">{label}</span>
    {children}
  </label>
);
