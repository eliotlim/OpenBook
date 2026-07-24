import {useCallback, useEffect, useState} from 'react';
import type {AgentEditsMode, InstanceInfo} from '@book.dev/sdk';
import {useData} from '@/data';
import {useTranslation} from '@/providers';
import {Select} from '@/components/ui/select';
import {SettingsSection, SettingsField} from '@/components/settings/primitives';
import {SETTINGS_SECTION_AGENTS_EDITS} from '@/lib/settingsIndex';

/**
 * The instance-wide agent-edits mode (AGED-5): whether an agent (an MCP client or
 * the built-in AI) edits pages DIRECTLY or files each change as a suggestion for a
 * human to accept. `'suggest'` is the safe default. This is the library-wide floor;
 * a page may override it via its per-page policy (the Customise pane), and the
 * effective decision is `resolveAgentEdits`.
 *
 * Owner-gated: `PUT /api/instance` is owner-only (the server is authoritative), so
 * a non-owner admin sees the current value but a disabled control + a lock hint,
 * mirroring `SharingSection`. Reads via `getInstanceInfo`, which works over every
 * transport (desktop server, in-webview PGlite) — so this renders even where the
 * agent-token surfaces above report "unavailable" (the browser).
 */
export default function AgentEditsSettings() {
  const client = useData();
  const {t} = useTranslation();
  const [info, setInfo] = useState<InstanceInfo | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    client
      .getInstanceInfo()
      .then(setInfo)
      .catch(() => setUnavailable(true));
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const change = useCallback(
    async (mode: AgentEditsMode) => {
      // A re-selection of the displayed value is a true no-op — never a write.
      if (!info || mode === (info.agentEdits ?? 'suggest')) return;
      setBusy(true);
      setError(null);
      try {
        await client.setInstancePolicy({agentEdits: mode});
        refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [client, refresh, info],
  );

  if (unavailable || !info) return null;

  // No claimed owner yet → anyone may set the policy (the first user claims the
  // library); once claimed, only that owner (matching SharingSection / the server).
  const isOwner = !info.ownerSubject || info.ownerSubject === info.you.subject;
  const mode: AgentEditsMode = info.agentEdits ?? 'suggest';

  return (
    <div id={SETTINGS_SECTION_AGENTS_EDITS} className="scroll-mt-4">
      <SettingsSection title={t('agentEdits.title')} description={t('agentEdits.description')}>
        <SettingsField label={t('agentEdits.modeLabel')} hint={t('agentEdits.modeHint')}>
          <Select
            value={mode}
            wrapperClassName="w-[240px]"
            aria-label={t('agentEdits.modeLabel')}
            disabled={busy || !isOwner}
            onChange={(e) => void change(e.target.value as AgentEditsMode)}
          >
            <option value="suggest">{t('agentEdits.modeSuggest')}</option>
            <option value="direct">{t('agentEdits.modeDirect')}</option>
          </Select>
        </SettingsField>
        {!isOwner && <p className="text-xs text-muted-foreground">{t('agentEdits.ownerLocked')}</p>}
        {error && <p className="text-xs text-destructive">{t('agentEdits.saveError', {error})}</p>}
      </SettingsSection>
    </div>
  );
}
