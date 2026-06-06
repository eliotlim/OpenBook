import {useEffect, useState} from 'react';
import {Copy, Minus, Square, X} from 'lucide-react';
import {usePlatformLibrary} from '@/providers';
import {cn} from '@/lib/utils';

/**
 * Minimize / maximize / close buttons for a frameless window (Windows & Linux,
 * where the host provides `windowControls`). Drawn on the right of the titlebar
 * strip. Renders nothing on macOS / the web, which keep their native controls.
 */
export default function WindowControls() {
  const {windowControls} = usePlatformLibrary();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!windowControls?.watchMaximized) return;
    return windowControls.watchMaximized(setMaximized);
  }, [windowControls]);

  if (!windowControls) return null;

  const button = 'flex h-full w-[46px] items-center justify-center text-muted-foreground transition-colors';

  return (
    <div className="flex h-full shrink-0 items-stretch">
      <button
        type="button"
        onClick={windowControls.minimize}
        aria-label="Minimize"
        className={cn(button, 'hover:bg-accent hover:text-foreground')}
      >
        <Minus className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={windowControls.toggleMaximize}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        className={cn(button, 'hover:bg-accent hover:text-foreground')}
      >
        {maximized ? <Copy className="h-3.5 w-3.5 -scale-x-100" /> : <Square className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={windowControls.close}
        aria-label="Close"
        className={cn(button, 'hover:bg-red-600 hover:text-white')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
