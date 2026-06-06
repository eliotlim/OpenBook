import React, {createContext, useCallback, useContext, useRef, useState} from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';

export interface ConfirmOptions {
  /** Bold heading, e.g. "Move page to trash?". */
  title: string;
  /** Supporting line under the title. */
  description?: string;
  /** Confirm button label (default "Confirm"). */
  confirmText?: string;
  /** Cancel button label (default "Cancel"). */
  cancelText?: string;
  /** Render the confirm button in the destructive (red) style. */
  destructive?: boolean;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Promise-based confirmation dialog: `const confirm = useConfirm()` then
 * `if (!(await confirm({title: '…'}))) return;`. A drop-in for `window.confirm`
 * that actually works in the desktop WKWebView shell, where the native
 * `window.confirm` returns false without ever showing a dialog and so silently
 * aborts the action. Renders one in-app Radix dialog shared by every caller;
 * all controls are native `<button>`s so clicks fire in WKWebView.
 */
export function ConfirmProvider({children}: {children: React.ReactNode}) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const settle = useCallback((value: boolean) => {
    resolverRef.current?.(value);
    resolverRef.current = null;
    setOptions(null);
  }, []);

  const confirm = useCallback<ConfirmFn>((opts) => {
    // A fresh request supersedes any still-open one (resolve the old as cancelled).
    resolverRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setOptions(opts);
    });
  }, []);

  // Radix fires onOpenChange(false) on Escape, overlay click, and the close (X)
  // button — all of which mean "cancel".
  const onOpenChange = useCallback(
    (next: boolean) => {
      if (!next) settle(false);
    },
    [settle],
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={options !== null} onOpenChange={onOpenChange}>
        {options && (
          <DialogContent className="sm:max-w-[420px]">
            <DialogHeader>
              <DialogTitle>{options.title}</DialogTitle>
              {options.description && <DialogDescription>{options.description}</DialogDescription>}
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => settle(false)}>
                {options.cancelText ?? 'Cancel'}
              </Button>
              <Button
                variant={options.destructive ? 'destructive' : 'default'}
                onClick={() => settle(true)}
              >
                {options.confirmText ?? 'Confirm'}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/** Access the promise-based confirm dialog. Throws outside a {@link ConfirmProvider}. */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used within a <ConfirmProvider>');
  return ctx;
}
