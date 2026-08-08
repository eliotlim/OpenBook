import {useCallback, useEffect, useState} from 'react';
import type {InstanceInfo} from '@book.dev/sdk';
import {useData} from '@/data';
import {useTranslation} from '@/providers';
import {Button} from '@/components/ui/button';
import {Switch} from '@/components/ui/switch';
import {SettingsSection, SettingsField} from '@/components/settings/primitives';
import {SETTINGS_SECTION_LEDGER_AUTOEXPORT} from '@/lib/settingsIndex';

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
 * disabled control and a lock hint. Hidden entirely when the server does not
 * surface the field (a pre-LGR-7 server, or an anonymous caller the identity
 * gate hides it from).
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
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [client, refresh],
  );

  // The field is identity-gated server-side: absent means "nothing to manage
  // here" (pre-LGR-7, or a caller the instance hides identity info from).
  if (unavailable || !info || info.ledgerAutoExportPath === undefined) return null;

  const isOwner = !info.ownerSubject || info.ownerSubject === info.you.subject;
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
              className="w-[340px] max-w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm focus-visible:outline-hidden focus-visible:shadow-[var(--ring-control)]"
            />
            {enabled && dirty && (
              <Button size="sm" disabled={busy || !isOwner || path.trim() === ''} onClick={() => void save(path.trim())}>
                {t('ledgerAutoExport.save')}
              </Button>
            )}
          </div>
        </SettingsField>
        {!isOwner && <p className="text-xs text-muted-foreground">{t('ledgerAutoExport.ownerLocked')}</p>}
        {error && <p className="text-xs text-destructive">{t('ledgerAutoExport.saveError', {error})}</p>}
      </SettingsSection>
    </div>
  );
}
