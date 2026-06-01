import {useCallback, useEffect, useState} from 'react';
import {getServerUrlOverride, setServerUrlOverride, type ServerInfo} from '@open-book/sdk';
import {usePlatformLibrary} from '@/providers';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';

/**
 * Server management: connect to a remote server, or (on the desktop) start/stop
 * the bundled local server. Changing the connection reloads the app so the data
 * client re-initializes against the new target.
 */
export default function ServerSettings() {
  const {serverControls} = usePlatformLibrary();
  const connected = getServerUrlOverride();

  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [remoteUrl, setRemoteUrl] = useState(connected ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!serverControls) return;
    serverControls
      .info()
      .then(setInfo)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [serverControls]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runControl = useCallback(async (fn: () => Promise<ServerInfo>) => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const connectRemote = useCallback(() => {
    setServerUrlOverride(remoteUrl.trim() || null);
    if (typeof window !== 'undefined') window.location.reload();
  }, [remoteUrl]);

  const useLocal = useCallback(() => {
    setServerUrlOverride(null);
    if (typeof window !== 'undefined') window.location.reload();
  }, []);

  const localManaged = info?.managed ?? false;

  return (
    <div className="flex flex-col gap-8 w-full max-w-lg">
      <div>
        <h3 className="text-lg font-semibold">Server</h3>
        <p className="text-sm text-muted-foreground">
          Choose where this device reads and writes pages.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h4 className="text-sm font-semibold">Connection</h4>
        <p className="text-sm text-muted-foreground">
          Currently using {connected ? <>the remote server <code>{connected}</code></> : 'this device’s local server'}.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="remote-url">Remote server URL</Label>
          <Input
            id="remote-url"
            value={remoteUrl}
            placeholder="https://my-server.example:4319"
            onChange={(e) => setRemoteUrl(e.target.value)}
          />
        </div>
        <div className="flex gap-2">
          <Button onClick={connectRemote} disabled={!remoteUrl.trim() || remoteUrl.trim() === connected}>
            Connect
          </Button>
          <Button variant="outline" onClick={useLocal} disabled={!connected}>
            Use local
          </Button>
        </div>
      </section>

      {serverControls && (
        <section className="flex flex-col gap-3">
          <h4 className="text-sm font-semibold">Local server</h4>
          <p className="text-sm text-muted-foreground">
            {info
              ? info.running
                ? <>Running at <code>{info.address}</code>.</>
                : 'Stopped.'
              : 'Checking…'}
          </p>
          {info && !localManaged && (
            <p className="text-xs text-muted-foreground">
              Managed by the dev environment — start/stop is unavailable here.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              onClick={() => void runControl(() => serverControls.start())}
              disabled={busy || !localManaged || info?.running === true}
            >
              Start
            </Button>
            <Button
              variant="outline"
              onClick={() => void runControl(() => serverControls.stop())}
              disabled={busy || !localManaged || info?.running === false}
            >
              Stop
            </Button>
            <Button variant="ghost" onClick={refresh} disabled={busy}>
              Refresh
            </Button>
          </div>
        </section>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
