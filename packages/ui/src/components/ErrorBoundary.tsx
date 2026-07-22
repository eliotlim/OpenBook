import * as React from 'react';
import {TriangleAlert} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {cn} from '@/lib/utils';

/**
 * A generic React error boundary (STAB-3). React has no hook equivalent, so this
 * stays a class. It renders {@link ErrorBoundaryProps.fallback} when a descendant
 * throws while rendering, keeping one poisoned subtree from blanking the whole
 * app. `resetKey` auto-clears the caught error when it changes — pass the page id
 * so navigating to another page recovers without a manual reset.
 */
export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Rendered in place of the children once a render throws. */
  fallback: (ctx: {error: Error; reset: () => void}) => React.ReactNode;
  /** Side-effect on catch (log, quarantine the page, clear the last-page key). */
  onError?: (error: Error, info: React.ErrorInfo) => void;
  /** When this value changes after a catch, the boundary resets and re-renders. */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {error: null};

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {error};
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({error: null});
  }

  reset = (): void => this.setState({error: null});

  render(): React.ReactNode {
    if (this.state.error) return this.props.fallback({error: this.state.error, reset: this.reset});
    return this.props.children;
  }
}

export interface ErrorFallbackProps {
  /** Short heading. */
  title?: string;
  /** One-line explanation. */
  message?: string;
  /** "Reload" action (whole app) — omitted when not applicable. */
  onReload?: () => void;
  /** "Go to Home" action — omitted when there's nowhere to go. */
  onHome?: () => void;
  /** `screen` fills the viewport (app crash); `inline` sits in the content column
   *  (one poisoned page, so the sidebar/nav stay visible around it). */
  variant?: 'screen' | 'inline';
}

/**
 * The recovery UI shown by an {@link ErrorBoundary}. Design-system primitives
 * only (Button + theme tokens) so it renders correctly even when the crash took
 * out a provider — copy is deliberately plain English (no i18n dependency), since
 * this must be bulletproof.
 */
export const ErrorFallback: React.FC<ErrorFallbackProps> = ({
  title = 'Something went wrong',
  message = 'This part of OpenBook ran into an unexpected error. Your work is saved — you can head back home or reload.',
  onReload,
  onHome,
  variant = 'screen',
}) => (
  <div
    role="alert"
    className={cn(
      'flex w-full items-center justify-center',
      variant === 'screen' ? 'fixed inset-0 z-50 bg-background p-6' : 'px-6 py-20',
    )}
  >
    <div className="flex max-w-sm flex-col items-center gap-4 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <TriangleAlert className="h-6 w-6" aria-hidden />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <p className="text-[15px] leading-relaxed text-muted-foreground">{message}</p>
      </div>
      {(onHome || onReload) && (
        <div className="flex items-center gap-2 pt-1">
          {onHome && (
            <Button variant="outline" onClick={onHome}>
              Go to Home
            </Button>
          )}
          {onReload && <Button onClick={onReload}>Reload</Button>}
        </div>
      )}
    </div>
  </div>
);
