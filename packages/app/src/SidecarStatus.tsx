import {useCallback, useEffect, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {Button, useTranslation, type SidecarPlatform, type SidecarState} from '@book.dev/ui';

const READINESS_GRACE_MS = 3000;

export function useSidecarStatus(): SidecarPlatform {
  const [state, setState] = useState<SidecarState | null>(null);
  const [graceElapsed, setGraceElapsed] = useState(false);

  useEffect(() => {
    let active = true;
    let eventReceived = false;
    const unlisten = listen<SidecarState>('sidecar-state', (event) => {
      eventReceived = true;
      if (active) setState(event.payload);
    });
    void invoke<SidecarState>('sidecar_state').then((next) => active && !eventReceived && setState(next)).catch(() => undefined);
    const recovered = (): void => setState((current) => current ? {...current, state: 'running', socketReady: true} : current);
    window.addEventListener('openbook://sidecar-request-success', recovered);
    return () => {
      active = false;
      void unlisten.then((fn) => fn());
      window.removeEventListener('openbook://sidecar-request-success', recovered);
    };
  }, []);

  useEffect(() => {
    setGraceElapsed(false);
    if (state?.state !== 'running' || state.socketReady) return;
    const timer = window.setTimeout(() => setGraceElapsed(true), READINESS_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  const restart = useCallback(async () => {
    const next = await invoke<SidecarState>('restart_sidecar');
    setState(next);
    return next;
  }, []);
  const degraded = state?.state === 'dead' || state?.state === 'respawning' || Boolean(state?.state === 'running' && !state.socketReady && graceElapsed);
  return {state, degraded, restart};
}

export function SidecarDegradedBanner({sidecar}: {sidecar: SidecarPlatform}) {
  const {t} = useTranslation();
  const [restarting, setRestarting] = useState(false);
  if (!sidecar.degraded || !sidecar.state) return null;
  const state = sidecar.state;
  const stateLine = state.state === 'dead'
    ? t('sidecar.dead')
    : state.state === 'respawning'
      ? t('sidecar.respawning', {attempts: state.attempts})
      : t('sidecar.notReady');
  const restart = async (): Promise<void> => {
    setRestarting(true);
    try { await sidecar.restart(); } catch { /* The next host event remains authoritative. */ } finally { setRestarting(false); }
  };
  return (
    <aside role="alert" className="flex flex-col gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-foreground">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-medium">{t('sidecar.bannerTitle')}</p>
          <p className="text-muted-foreground">{stateLine}{state.lastExitCode == null ? '' : ` · ${t('sidecar.exitCode', {code: state.lastExitCode})}`}</p>
        </div>
        <Button size="sm" variant="outline" disabled={restarting} onClick={() => void restart()}>
          {restarting ? t('sidecar.restarting') : t('sidecar.restart')}
        </Button>
      </div>
      {state.lastStderrTail.length > 0 && <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-background/70 p-2 font-mono text-xs">{state.lastStderrTail.join('\n')}</pre>}
    </aside>
  );
}
