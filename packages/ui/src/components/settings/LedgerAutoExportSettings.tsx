import {useCallback, useEffect, useState} from 'react';
import type {InstanceInfo} from '@book.dev/sdk';
import {useData} from '@/data';
import {useTranslation} from '@/providers';
import {Button} from '@/components/ui/button';
import {Switch} from '@/components/ui/switch';
import {cleanError, isInstanceOwner} from '@/components/settings/adminGate';
import {SettingsSection, SettingsField} from '@/components/settings/primitives';
import {SETTINGS_SECTION_LEDGER_AUTOEXPORT} from '@/lib/settingsIndex';

const OWNER_LOCKED_ID = 'ledger-auto-export-owner-locked';

/**
 * Ledger auto-export (LGR-7 insurance; surfaced by LX-4): after every ledger
 * mutation the server writes the canonical postings CSV to an owner-configured
 * file — debounced, atomically — so the books ALWAYS exist on disk in a
 * canonical, tool-readable form even if the app never opens again. OFF by
 * default (no ambient file writes); this section is the one visible switch.
 *
 * The server treats the target as hostile (fenced to its allowed export roots,
 * `<dataDir>/exports` by default), so a path outside the fence is refused at
 * export time — the hint says where the fence is, and a server-side refusal
 * surfaces here on save.
 *
 * Owner-gated exactly like {@link AgentEditsSettings}: `PUT /api/instance` is
 * owner-only server-side; a non-owner admin sees the current value with a
 * disabled control and a lock hint. A claimed anonymous caller receives a
 * redacted `null`, so they see the off state locked; hidden entirely only when a
 * pre-LGR-7 server does not surface the field.
 *
 * i18n: the `ledgerAutoExport.*` strings are English-only BY PRECEDENT — the
 * partial locales (de/ja/zh) carry no admin-surface namespaces at all (see
 * `agentEdits`, `aiUsage`), and the i18n layer falls back to `en` per key.
 */
export default function LedgerAutoExportSettings() {
  const client = useData();
  const {t} = useTranslation();
  const [info, setInfo] = useState<InstanceInfo | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    client
      .getInstanceInfo()
      .then((next) => {
        setInfo(next);
        setPath(next.ledgerAutoExportPath ?? '');
      })
      .catch(() => setUnavailable(true));
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const save = useCallback(
    async (next: string | null) => {
      setBusy(true);
      setError(null);
      try {
        await client.setInstancePolicy({ledgerAutoExportPath: next});
        refresh();
      } catch (e) {
        setError(cleanError(e, t('share.error.generic')));
      } finally {
        setBusy(false);
      }
    },
    [client, refresh, t],
  );

  // Absent means a pre-LGR-7 server has nothing to manage here. Identity
  // redaction is `null`, not `undefined`, so a claimed guest still reaches the
  // owner gate below and sees an honest locked state.
  if (unavailable || !info || info.ledgerAutoExportPath === undefined) return null;

  const isOwner = isInstanceOwner(info);
  const enabled = info.ledgerAutoExportPath !== null;
  const dirty = path.trim() !== (info.ledgerAutoExportPath ?? '');

  return (
    <div id={SETTINGS_SECTION_LEDGER_AUTOEXPORT} className="scroll-mt-4">
      <SettingsSection title={t('ledgerAutoExport.title')} description={t('ledgerAutoExport.description')}>
        <SettingsField label={t('ledgerAutoExport.toggleLabel')} hint={t('ledgerAutoExport.toggleHint')}>
          <Switch
            checked={enabled}
            disabled={busy || !isOwner || (!enabled && path.trim() === '')}
            aria-label={t('ledgerAutoExport.toggleLabel')}
            aria-describedby={isOwner ? undefined : OWNER_LOCKED_ID}
            onCheckedChange={(next) => void save(next ? path.trim() : null)}
          />
        </SettingsField>
        <SettingsField label={t('ledgerAutoExport.pathLabel')} hint={t('ledgerAutoExport.pathHint')}>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={path}
              disabled={busy || !isOwner}
              onChange={(e) => setPath(e.target.value)}
              placeholder={t('ledgerAutoExport.pathPlaceholder')}
              aria-label={t('ledgerAutoExport.pathLabel')}
              aria-describedby={isOwner ? undefined : OWNER_LOCKED_ID}
              className="w-[340px] max-w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus-visible:outline-hidden focus-visible:shadow-[var(--ring-control)]"
            />
            {enabled && dirty && (
              <Button size="sm" disabled={busy || !isOwner || path.trim() === ''} onClick={() => void save(path.trim())}>
                {t('ledgerAutoExport.save')}
              </Button>
            )}
          </div>
        </SettingsField>
        {!isOwner && (
          <p id={OWNER_LOCKED_ID} className="text-xs text-muted-foreground">
            {t('ledgerAutoExport.ownerLocked')}
          </p>
        )}
        {error && <p className="text-xs text-destructive">{t('ledgerAutoExport.saveError', {error})}</p>}
      </SettingsSection>
    </div>
  );
}
