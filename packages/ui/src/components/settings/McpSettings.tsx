import {useCallback, useEffect, useState} from 'react';
import {Trash2} from 'lucide-react';
import type {InstanceInfo, McpClientConfig, McpServerConfig, McpTransport} from '@book.dev/sdk';
import {useData} from '@/data';
import {useTranslation} from '@/providers';
import {Button} from '@/components/ui/button';
import {Select} from '@/components/ui/select';
import {SettingsField, SettingsSection, SettingsToggle, SETTINGS_CONTROL_CLASS} from '@/components/settings/primitives';

/**
 * Settings → AI → External tools (MCP). The admin-only surface to register
 * external MCP servers whose tools the in-app agent may call. RENDERS NOTHING for
 * a non-admin (the `AiUsageSettings` hide-not-break pattern): a claimed-instance
 * non-admin is hidden up front, and the admin-only `/api/ai/mcp` GET's 403 is the
 * authoritative refusal. Off + empty by default; the `stdio` (local command)
 * transport is offered only when the server reports `stdioAllowed` (desktop /
 * unclaimed) — on a claimed instance it's hidden AND server-rejected.
 */

function isForbidden(e: unknown): boolean {
  const raw = e instanceof Error ? e.message : String(e);
  return /\b40[13]\b|forbidden|unauthor/i.test(raw);
}

function isAdminRole(info: InstanceInfo): boolean {
  if (info.localOwner === true) return true;
  if (info.you.verifiedVia === 'local') return true;
  if (info.ownerSubject && info.you.verifiedVia === 'jws' && info.you.subject === info.ownerSubject) return true;
  return info.youRole === 'owner' || info.youRole === 'admin';
}

/** A blank server row (HTTP by default — the transport available everywhere). */
function blankServer(): McpServerConfig {
  return {id: '', name: '', transport: 'http', url: '', enabled: false};
}

export default function McpSettings() {
  const client = useData();
  const {t} = useTranslation();
  const [gate, setGate] = useState<'loading' | 'hidden' | 'ready'>('loading');
  const [config, setConfig] = useState<McpClientConfig>({enabled: false, servers: []});
  const [stdioAllowed, setStdioAllowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Per-server Test outcomes, keyed by row index.
  const [tests, setTests] = useState<Record<number, {ok: boolean; msg: string} | 'running'>>({});

  const load = useCallback(async () => {
    try {
      const info = await client.getInstanceInfo();
      if (info.ownerSubject && !isAdminRole(info)) {
        setGate('hidden');
        return;
      }
    } catch {
      /* inconclusive — the endpoint 403 below decides */
    }
    try {
      const res = await client.getMcpConfig();
      setConfig(res.config);
      setStdioAllowed(res.stdioAllowed);
      setGate('ready');
    } catch (e) {
      if (!isForbidden(e)) console.debug('MCP settings unavailable:', e);
      setGate('hidden');
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // Persist the whole config; the server re-redacts, so adopt its response (which
  // masks tokens back to a "set" state) and scrub any raw token we just sent.
  const save = useCallback(
    async (next: McpClientConfig) => {
      setBusy(true);
      setError(null);
      try {
        const res = await client.putMcpConfig(next);
        setConfig(res.config);
        setStdioAllowed(res.stdioAllowed);
      } catch (e) {
        setError(t('ai.mcp.saveError', {error: e instanceof Error ? e.message : String(e)}));
      } finally {
        setBusy(false);
      }
    },
    [client, t],
  );

  if (gate !== 'ready') return null;

  const setServer = (i: number, patch: Partial<McpServerConfig>): McpClientConfig => ({
    ...config,
    servers: config.servers.map((s, idx) => (idx === i ? {...s, ...patch} : s)),
  });

  const test = async (i: number): Promise<void> => {
    setTests((prev) => ({...prev, [i]: 'running'}));
    try {
      const res = await client.testMcpServer(config.servers[i]);
      setTests((prev) => ({
        ...prev,
        [i]: res.ok
          ? {ok: true, msg: t('ai.mcp.testOk', {count: String(res.tools?.length ?? 0), tools: (res.tools ?? []).join(', ') || '—'})}
          : {ok: false, msg: t('ai.mcp.testFail', {error: res.error ?? 'error'})},
      }));
    } catch (e) {
      setTests((prev) => ({...prev, [i]: {ok: false, msg: t('ai.mcp.testFail', {error: e instanceof Error ? e.message : String(e)})}}));
    }
  };

  return (
    <SettingsSection title={t('ai.mcp.title')} description={t('ai.mcp.hint')}>
      <SettingsToggle
        label={t('ai.mcp.enable')}
        hint={t('ai.mcp.enableHint')}
        checked={config.enabled}
        disabled={busy}
        onCheckedChange={(checked) => void save({...config, enabled: checked})}
      />

      {!stdioAllowed && <p className="text-xs text-muted-foreground">{t('ai.mcp.stdioHiddenHint')}</p>}

      <div className="flex flex-col gap-3">
        {config.servers.length === 0 && <p className="text-sm text-muted-foreground">{t('ai.mcp.empty')}</p>}
        {config.servers.map((s, i) => {
          const showTokenSet = Boolean(s.authTokenSet) && s.authToken == null;
          const outcome = tests[i];
          return (
            <div key={i} data-mcp-server className="flex flex-col gap-2 rounded-md border border-border p-3">
              <div className="flex items-center justify-between gap-3">
                <SettingsToggle
                  label={t('ai.mcp.enableServer')}
                  checked={s.enabled}
                  disabled={busy}
                  onCheckedChange={(checked) => void save(setServer(i, {enabled: checked}))}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('ai.mcp.delete')}
                  disabled={busy}
                  onClick={() => void save({...config, servers: config.servers.filter((_, idx) => idx !== i)})}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>

              <SettingsField label={t('ai.mcp.serverName')}>
                <input
                  className={SETTINGS_CONTROL_CLASS}
                  value={s.name ?? ''}
                  placeholder={t('ai.mcp.serverNamePlaceholder')}
                  onChange={(e) => setConfig(setServer(i, {name: e.target.value}))}
                  onBlur={() => void save(config)}
                />
              </SettingsField>

              <SettingsField label={t('ai.mcp.serverId')} hint={t('ai.mcp.serverIdHint')}>
                <input
                  className={SETTINGS_CONTROL_CLASS}
                  value={s.id}
                  placeholder="my-tools"
                  onChange={(e) => setConfig(setServer(i, {id: e.target.value}))}
                  onBlur={() => void save(config)}
                />
              </SettingsField>

              <SettingsField label={t('ai.mcp.transport')}>
                <Select
                  value={s.transport}
                  wrapperClassName="w-[240px]"
                  disabled={busy}
                  onChange={(e) => void save(setServer(i, {transport: e.target.value as McpTransport}))}
                >
                  <option value="http">{t('ai.mcp.transportHttp')}</option>
                  {/* stdio only offered where the instance trust level allows it */}
                  {(stdioAllowed || s.transport === 'stdio') && <option value="stdio">{t('ai.mcp.transportStdio')}</option>}
                </Select>
              </SettingsField>

              {s.transport === 'http' ? (
                <SettingsField label={t('ai.mcp.url')}>
                  <input
                    className={SETTINGS_CONTROL_CLASS}
                    value={s.url ?? ''}
                    placeholder={t('ai.mcp.urlPlaceholder')}
                    onChange={(e) => setConfig(setServer(i, {url: e.target.value}))}
                    onBlur={() => void save(config)}
                  />
                </SettingsField>
              ) : (
                <>
                  <p className="text-xs text-destructive">{t('ai.mcp.stdioWarn')}</p>
                  <SettingsField label={t('ai.mcp.command')}>
                    <input
                      className={SETTINGS_CONTROL_CLASS}
                      value={s.command ?? ''}
                      placeholder={t('ai.mcp.commandPlaceholder')}
                      onChange={(e) => setConfig(setServer(i, {command: e.target.value}))}
                      onBlur={() => void save(config)}
                    />
                  </SettingsField>
                  <SettingsField label={t('ai.mcp.args')}>
                    <textarea
                      className={SETTINGS_CONTROL_CLASS}
                      rows={2}
                      value={(s.args ?? []).join('\n')}
                      placeholder={t('ai.mcp.argsPlaceholder')}
                      onChange={(e) => setConfig(setServer(i, {args: e.target.value.split('\n').map((a) => a.trim()).filter(Boolean)}))}
                      onBlur={() => void save(config)}
                    />
                  </SettingsField>
                </>
              )}

              <SettingsField label={t('ai.mcp.token')} hint={t('ai.mcp.tokenHint')}>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    autoComplete="off"
                    className={SETTINGS_CONTROL_CLASS}
                    value={typeof s.authToken === 'string' ? s.authToken : ''}
                    placeholder={showTokenSet ? t('ai.mcp.tokenSet') : ''}
                    onChange={(e) => setConfig(setServer(i, {authToken: e.target.value}))}
                    onBlur={() => void save(config)}
                  />
                  {showTokenSet && (
                    <Button size="sm" variant="outline" className="shrink-0" disabled={busy} onClick={() => void save(setServer(i, {authToken: null}))}>
                      {t('ai.mcp.tokenClear')}
                    </Button>
                  )}
                </div>
              </SettingsField>

              <div className="flex items-center gap-3">
                <Button size="sm" variant="outline" disabled={busy || outcome === 'running'} onClick={() => void test(i)}>
                  {outcome === 'running' ? t('ai.mcp.testing') : t('ai.mcp.test')}
                </Button>
                {outcome && outcome !== 'running' && (
                  <span className={outcome.ok ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}>{outcome.msg}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          // Add the blank row to LOCAL state only — it has an empty id, which the
          // server would reject (SLUG_RE) with a 400. The per-field onBlur persists
          // it once the admin has entered a valid id + endpoint.
          onClick={() => setConfig({...config, servers: [...config.servers, blankServer()]})}
        >
          {t('ai.mcp.addServer')}
        </Button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </SettingsSection>
  );
}
