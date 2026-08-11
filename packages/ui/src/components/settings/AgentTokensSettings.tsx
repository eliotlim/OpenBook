import {useCallback, useEffect, useState} from 'react';
import {Check, Copy, Loader2, Trash2} from 'lucide-react';
import type {AgentTokenMeta, AgentTokenScope, CreatedAgentToken} from '@book.dev/sdk';
import {useData} from '@/data';
import {useConfirm, usePlatformCapabilities, useTranslation} from '@/providers';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Select} from '@/components/ui/select';
import {IconButton} from '@/components/ui/icon-button';
import {SettingsField, SettingsScreen, SettingsSection, SettingsToggle} from '@/components/settings/primitives';
import {isForbidden, useIsSettingsAdmin} from '@/components/settings/adminGate';
import McpSettings from '@/components/settings/McpSettings';
import AiUsageSettings from '@/components/settings/AiUsageSettings';
import AgentEditsSettings from '@/components/settings/AgentEditsSettings';
import {SETTINGS_SECTION_AGENTS_MCP, SETTINGS_SECTION_AGENTS_USAGE} from '@/lib/settingsIndex';
import {copyText} from '@/lib/pageActions';

/** Extract the server's human detail out of the SDK's `request()` wrapper. */
function cleanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const m = raw.match(/OpenBook request failed \([^)]*\)(?::\s*([\s\S]*))?$/);
  return (m?.[1] ?? raw).trim();
}

/** The in-webview (browser) client rejects with this shape — no HTTP server to mint
 *  PATs against — so the panel shows an "unavailable" notice, not a live toggle. */
function isUnavailable(e: unknown): boolean {
  const raw = e instanceof Error ? e.message : String(e);
  return /not in the browser|unavailable/i.test(raw);
}

type Expiry = '90' | '30' | 'never';
const EXPIRY_DAYS: Record<Expiry, number | null> = {'90': 90, '30': 30, never: null};

const fmtDate = (iso: string | null): string | null => (iso ? new Date(iso).toLocaleDateString() : null);

/**
 * The "Agents & AI admin" tab (SET2-2). Leads with agent access (AGENT-6):
 * admin-only management of `obat_…` personal access tokens — a dark on/off switch
 * for the agent API, a create form that reveals the plaintext exactly ONCE, and a
 * revocable list. Below it sit the two other admin-only surfaces relocated out of
 * the everyday AI tab: external tools (MCP client) and AI usage/pricing/retention.
 * The whole tab is hidden from the rail for a confirmed non-admin
 * ({@link useIsSettingsAdmin}); each surface still self-gates (server-side
 * `requireInstanceAdmin` is authoritative) as defence in depth for a deep-link.
 * Runs against a real server — the in-webview browser store reports the token
 * feature unavailable.
 */
export default function AgentTokensSettings() {
  const client = useData();
  const {t} = useTranslation();
  const confirm = useConfirm();
  const isAdmin = useIsSettingsAdmin();
  // The desktop host can bind the loopback TCP endpoint a local MCP connector needs
  // (STAB-5). Absent on the web / an old host — the connector setup block hides then.
  const {serverControls} = usePlatformCapabilities();

  const [canManage, setCanManage] = useState<boolean | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  // This library's stable id, baked into the connector config so the connector can
  // verify it reached THIS library and refuse a foreign responder on the port.
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [remoteEnabled, setRemoteEnabled] = useState(false);
  const [tokens, setTokens] = useState<AgentTokenMeta[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [scope, setScope] = useState<AgentTokenScope>('read');
  const [remote, setRemote] = useState(false);
  const [expiry, setExpiry] = useState<Expiry>('90');
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedAgentToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [connectorCopied, setConnectorCopied] = useState(false);

  // The MCP client registration for THIS library: the loopback endpoint plus the
  // instance id the connector verifies before adopting the server (STAB-5). The
  // binary path is where the connector is installed; the env vars are the load-bearing part.
  const connectorConfig = [
    'claude mcp add openbook \\',
    '  --env OPENBOOK_URL=http://127.0.0.1:4319 \\',
    ...(instanceId ? [`  --env OPENBOOK_INSTANCE_ID=${instanceId} \\`] : []),
    '  -- node /path/to/openbook-mcp/dist/bin.js',
  ].join('\n');

  const copyConnectorConfig = async () => {
    if (await copyText(connectorConfig)) {
      setConnectorCopied(true);
      setTimeout(() => setConnectorCopied(false), 1500);
    }
  };

  const refresh = useCallback(async () => {
    try {
      const res = await client.listAgentTokens();
      setEnabled(res.enabled);
      setRemoteEnabled(res.remote);
      if (!res.remote) setRemote(false); // can't mint remote while remote MCP is off
      setTokens(res.tokens);
      setCanManage(true);
      setLoadError(null);
      // Best-effort: read the library id for the connector snippet. A failure here
      // (older server without the field) just hides the id line — never blocks the tab.
      try {
        setInstanceId((await client.getInstanceInfo()).instanceId ?? null);
      } catch {
        setInstanceId(null);
      }
    } catch (e) {
      if (isUnavailable(e)) {
        setUnavailable(true);
        return;
      }
      if (isForbidden(e)) {
        setCanManage(false);
        return;
      }
      setCanManage(true);
      setLoadError(cleanError(e));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (next: boolean) => {
    setToggling(true);
    setActionError(null);
    try {
      if (!next) {
        // STAB-5 disable path: UNBIND the loopback TCP listener FIRST so the port
        // is never left reachable while the UI reports the feature as off. Unlike
        // the enable path, a failure here is surfaced (not swallowed): a still-bound
        // port is a real exposure, so we don't claim "disabled" until it's gone.
        await serverControls?.setAgentLocalTcp?.(false);
        // Turning the whole feature off also forces remote off (server enforces this).
        const res = await client.setAgentApiEnabled(false, false);
        setEnabled(res.enabled);
        setRemoteEnabled(res.remote);
        await refresh();
        return;
      }
      const res = await client.setAgentApiEnabled(next, next && remoteEnabled);
      setEnabled(res.enabled);
      setRemoteEnabled(res.remote);
      // STAB-5: the local-MCP/agent toggle also drives the desktop host's loopback
      // TCP bind, so an out-of-process connector's default endpoint actually points
      // at this library's server. Best-effort on ENABLE — a host without the
      // capability (web, an older build) simply skips it; the server-side gate still
      // flips. (On disable the bind is unwound first, above, and failures surface.)
      try {
        await serverControls?.setAgentLocalTcp?.(next);
      } catch {
        /* non-fatal: the LAN bind is a desktop convenience, not the auth gate */
      }
      await refresh();
    } catch (e) {
      setActionError(cleanError(e));
    } finally {
      setToggling(false);
    }
  };

  const toggleRemote = async (next: boolean) => {
    setToggling(true);
    setActionError(null);
    try {
      const res = await client.setAgentApiEnabled(enabled, next);
      setRemoteEnabled(res.remote);
      if (!res.remote) setRemote(false);
      await refresh();
    } catch (e) {
      setActionError(cleanError(e));
    } finally {
      setToggling(false);
    }
  };

  const create = async () => {
    if (!name.trim()) return;
    setCreating(true);
    setActionError(null);
    setCreated(null);
    setCopied(false);
    try {
      // Remote tokens must expire (server rejects `null`); coerce a lingering "never"
      // selection to the 30-day default.
      const expiresInDays = remote && EXPIRY_DAYS[expiry] === null ? 30 : EXPIRY_DAYS[expiry];
      const res = await client.createAgentToken({name: name.trim(), scope, expiresInDays, remote});
      setCreated(res);
      setName('');
      await refresh();
    } catch (e) {
      setActionError(cleanError(e));
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (token: AgentTokenMeta) => {
    const ok = await confirm({
      title: t('agents.revokeConfirmTitle'),
      description: t('agents.revokeConfirmBody'),
      confirmText: t('agents.revokeConfirmButton'),
      destructive: true,
    });
    if (!ok) return;
    setBusyId(token.id);
    setActionError(null);
    try {
      await client.revokeAgentToken(token.id);
      await refresh();
    } catch (e) {
      setActionError(cleanError(e));
    } finally {
      setBusyId(null);
    }
  };

  const copy = async () => {
    if (!created) return;
    if (await copyText(created.token)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  // Single admin-gate pattern for this whole admin-only tab (SET2-10). A
  // *confirmed* non-admin who deep-links here (the rail already hides the tab)
  // sees one calm "admins only" notice and none of the surfaces below — the same
  // shared gate the rail uses. This is a COSMETIC label gate only: the server's
  // `requireInstanceAdmin` is the sole enforcement, so it's safe to fail OPEN
  // (unclaimed/inconclusive → render, then each surface's own 403 hides it). A
  // confirmed non-admin therefore never sees anything sensitive, and the three
  // embedded surfaces (tokens, MCP, usage) are uniformly SILENT on a server
  // refusal rather than mixing inline notices with `return null`.
  if (isAdmin === false) {
    return (
      <SettingsScreen title={t('agents.title')} description={t('agents.description')} scope="library">
        <p className="text-sm text-muted-foreground">{t('agents.adminOnly')}</p>
      </SettingsScreen>
    );
  }

  return (
    <SettingsScreen title={t('agents.title')} description={t('agents.description')} scope="library">
      {unavailable ? (
        <p className="text-sm text-muted-foreground">{t('agents.unavailable')}</p>
      ) : canManage === null ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : canManage === false ? (
        // Server said 403 despite the label gate letting us through (fail-open
        // path): stay silent, matching McpSettings / AiUsageSettings.
        null
      ) : (
        <>
          <SettingsToggle
            label={t('agents.enableTitle')}
            hint={t('agents.enableHint')}
            checked={enabled}
            onCheckedChange={(v) => void toggle(v)}
            disabled={toggling}
          />

          {enabled && (
            <SettingsToggle
              label={t('agents.remoteTitle')}
              hint={t('agents.remoteHint')}
              checked={remoteEnabled}
              onCheckedChange={(v) => void toggleRemote(v)}
              disabled={toggling}
            />
          )}

          {loadError && (
            <p role="alert" className="text-xs text-destructive">
              {loadError}
            </p>
          )}

          {/* Local MCP connector setup (STAB-5). Desktop only — the host binds the
              loopback endpoint the connector reaches. The snippet carries this exact
              library's id so the connector refuses a foreign responder on the port. */}
          {enabled && serverControls?.setAgentLocalTcp && (
            <SettingsSection title={t('agents.localMcpTitle')} description={t('agents.localMcpHint')}>
              <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
                <code>{connectorConfig}</code>
              </pre>
              <p className="text-xs text-muted-foreground">{t('agents.localMcpFollowsDefault')}</p>
              <div>
                <Button variant="secondary" size="sm" onClick={() => void copyConnectorConfig()}>
                  {connectorCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {connectorCopied ? t('agents.copied') : t('agents.localMcpCopy')}
                </Button>
              </div>
            </SettingsSection>
          )}

          {enabled && (
            <SettingsSection title={t('agents.createTitle')} description={t('agents.capNote')}>
              <SettingsField label={t('agents.nameLabel')}>
                <Input
                  inputSize="sm"
                  value={name}
                  placeholder={t('agents.namePlaceholder')}
                  onChange={(e) => setName(e.target.value)}
                  disabled={creating}
                />
              </SettingsField>
              <div className="flex flex-wrap gap-3">
                <SettingsField label={t('agents.scopeLabel')} className="min-w-[220px] flex-1">
                  <Select
                    inputSize="sm"
                    value={scope}
                    aria-label={t('agents.scopeLabel')}
                    onChange={(e) => setScope(e.target.value as AgentTokenScope)}
                    disabled={creating}
                  >
                    <option value="read">{t('agents.scopeRead')}</option>
                    <option value="write">{t('agents.scopeWrite')}</option>
                  </Select>
                </SettingsField>
                <SettingsField label={t('agents.expiryLabel')} className="min-w-[140px]">
                  <Select
                    inputSize="sm"
                    value={remote && expiry === 'never' ? '30' : expiry}
                    aria-label={t('agents.expiryLabel')}
                    onChange={(e) => setExpiry(e.target.value as Expiry)}
                    disabled={creating}
                  >
                    <option value="90">{t('agents.expiry90')}</option>
                    <option value="30">{t('agents.expiry30')}</option>
                    {/* Remote tokens must expire — hide "Never" when remote is selected. */}
                    {!remote && <option value="never">{t('agents.expiryNever')}</option>}
                  </Select>
                </SettingsField>
                {remoteEnabled && (
                  <SettingsField label={t('agents.remoteScopeLabel')} className="min-w-[180px]">
                    <Select
                      inputSize="sm"
                      value={remote ? 'remote' : 'local'}
                      aria-label={t('agents.remoteScopeLabel')}
                      onChange={(e) => {
                        const isRemote = e.target.value === 'remote';
                        setRemote(isRemote);
                        // A remote token defaults to the read scope (Q-d) — the safer
                        // default for an internet-reachable credential.
                        if (isRemote) setScope('read');
                      }}
                      disabled={creating}
                    >
                      <option value="local">{t('agents.remoteScopeLocal')}</option>
                      <option value="remote">{t('agents.remoteScopeRemote')}</option>
                    </Select>
                  </SettingsField>
                )}
              </div>
              {!remote && expiry === 'never' && <p className="text-xs text-muted-foreground">{t('agents.expiryNeverWarn')}</p>}
              {remote && <p className="text-xs text-muted-foreground">{t('agents.remoteExpiryNote')}</p>}
              <div>
                <Button onClick={() => void create()} disabled={creating || !name.trim()}>
                  {creating ? t('agents.creating') : t('agents.createButton')}
                </Button>
              </div>

              {created && (
                <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 p-3">
                  <span className="text-sm font-medium">{t('agents.revealTitle')}</span>
                  <span className="text-xs text-muted-foreground">{t('agents.revealHint')}</span>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-background px-2.5 py-1.5 font-mono text-xs">
                      {created.token}
                    </code>
                    <Button variant="secondary" size="sm" onClick={() => void copy()}>
                      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      {copied ? t('agents.copied') : t('agents.copy')}
                    </Button>
                  </div>
                  <div>
                    <Button variant="ghost" size="sm" onClick={() => setCreated(null)}>
                      {t('agents.revealDone')}
                    </Button>
                  </div>
                </div>
              )}
            </SettingsSection>
          )}

          {actionError && (
            <p role="alert" aria-live="assertive" className="text-xs text-destructive">
              {actionError}
            </p>
          )}

          <SettingsSection title={t('agents.listTitle')}>
            {tokens.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('agents.empty')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {tokens.map((tok) => (
                  <li
                    key={tok.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border px-3.5 py-2.5"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{tok.name || tok.preview}</span>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {tok.scope === 'write' ? t('agents.scopeWrite') : t('agents.scopeRead')}
                        </span>
                        {tok.remote && (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                            {t('agents.remoteBadge')}
                          </span>
                        )}
                        {tok.revoked && (
                          <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
                            {t('agents.revokedLabel')}
                          </span>
                        )}
                      </div>
                      <span className="truncate font-mono text-xs text-muted-foreground">{tok.preview}</span>
                      <span className="text-xs text-muted-foreground">
                        {tok.expiresAt ? t('agents.expiresOn', {date: fmtDate(tok.expiresAt) ?? ''}) : t('agents.neverExpires')}
                        {' · '}
                        {tok.lastUsedAt ? t('agents.lastUsed', {date: fmtDate(tok.lastUsedAt) ?? ''}) : t('agents.neverUsed')}
                      </span>
                    </div>
                    {!tok.revoked && (
                      <IconButton
                        aria-label={t('agents.revoke')}
                        title={t('agents.revoke')}
                        onClick={() => void revoke(tok)}
                        disabled={busyId === tok.id}
                      >
                        {busyId === tok.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      </IconButton>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SettingsSection>
        </>
      )}

      {/* Agent-edits mode (AGED-5): the library-wide floor for whether agents edit
          pages directly or file suggestions. Owner-gated + renders over every
          transport (self-fetches its own instance info), so it shows even where the
          token surfaces above report "unavailable" (the browser). */}
      <AgentEditsSettings />

      {/* External tools (MCP client). Admin-only (self-gated + 403-gated); off and
          empty by default; the stdio transport hides on a claimed instance. */}
      <div id={SETTINGS_SECTION_AGENTS_MCP} className="scroll-mt-4">
        <McpSettings />
      </div>

      {/* AI usage attribution + pricing + retention. Renders nothing unless YOU
          are an instance admin (self-gated + 403-gated); a viewer/guest sees none
          of it. */}
      <div id={SETTINGS_SECTION_AGENTS_USAGE} className="scroll-mt-4">
        <AiUsageSettings />
      </div>
    </SettingsScreen>
  );
}
