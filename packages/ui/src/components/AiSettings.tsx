import {useCallback, useEffect, useState} from 'react';
import type {AiConfig, AiProvider, AiStatus} from '@open-book/sdk';
import {SettingsField, SettingsScreen, SettingsSection} from '@/components/settings/primitives';
import {Button} from '@/components/ui/button';
import {useData} from '@/data';
import {useTranslation} from '@/providers';
import {cn} from '@/lib/utils';

const fieldClass =
  'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-hidden focus:border-ring';

/**
 * Settings → AI: the optional local model engine. Everything here talks to
 * the server's /api/ai surface; nothing runs in the browser. The provider
 * choices cover the cross-platform in-process engine (llama.cpp), Apple
 * Silicon's MLX, and any OpenAI-compatible local server.
 */
export default function AiSettings() {
  const client = useData();
  const {t} = useTranslation();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [draft, setDraft] = useState<AiConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await client.aiStatus();
      setStatus(next);
      setDraft((d) => d ?? next.config);
    } catch {
      setStatus(null);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while a model download is in flight.
  useEffect(() => {
    if (!status?.download || status.download.done || status.download.error) return;
    const timer = setTimeout(() => void refresh(), 1000);
    return () => clearTimeout(timer);
  }, [status, refresh]);

  const apply = async (config: AiConfig): Promise<void> => {
    setBusy(true);
    try {
      await client.aiSetConfig(config);
      setDraft(config);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!draft) {
    return (
      <SettingsScreen title={t('settings.tab.ai')}>
        <p className="text-sm text-muted-foreground">…</p>
      </SettingsScreen>
    );
  }

  const provider = draft.provider;
  const download = status?.download;
  const downloading = Boolean(download && !download.done && !download.error);
  const progress = download?.total ? Math.round((download.received / download.total) * 100) : null;

  const providers: Array<{id: AiProvider; label: string; hint: string}> = [
    {id: 'off', label: t('ai.provider.off'), hint: t('ai.provider.offHint')},
    {id: 'llama', label: t('ai.provider.llama'), hint: t('ai.provider.llamaHint')},
    {id: 'mlx', label: t('ai.provider.mlx'), hint: t('ai.provider.mlxHint')},
    {id: 'openai', label: t('ai.provider.openai'), hint: t('ai.provider.openaiHint')},
  ];

  return (
    <SettingsScreen title={t('settings.tab.ai')} description={t('ai.description')}>
      <SettingsSection>
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t('ai.providerLabel')}>
          {providers.map((p) => (
            <label
              key={p.id}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-6 rounded-md border px-3.5 py-3',
                provider === p.id ? 'border-ring bg-accent/40' : 'border-border hover:bg-accent/20',
              )}
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{p.label}</span>
                <span className="text-xs text-muted-foreground">{p.hint}</span>
              </span>
              <input
                type="radio"
                name="ai-provider"
                className="h-4 w-4 accent-primary"
                checked={provider === p.id}
                onChange={() => void apply({...draft, provider: p.id})}
                disabled={busy}
              />
            </label>
          ))}
        </div>

        {/* Engine status line */}
        {provider !== 'off' && status && (
          <p className={cn('text-xs', status.ready ? 'text-muted-foreground' : 'text-destructive')} data-ai-status>
            {status.ready
              ? t('ai.ready', {embeddings: status.embeddings ? t('ai.semantic') : t('ai.lexicalOnly')})
              : (status.detail ?? t('ai.notReady'))}
          </p>
        )}
      </SettingsSection>

      {provider === 'llama' && (
        <SettingsSection title={t('ai.model')}>
          <SettingsField label={t('ai.modelFile')} hint={t('ai.modelFileHint')}>
            <input
              className={fieldClass}
              value={draft.model ?? ''}
              placeholder="qwen2.5-1.5b-instruct-q4_k_m.gguf"
              onChange={(e) => setDraft({...draft, model: e.target.value})}
              onBlur={() => void apply(draft)}
            />
          </SettingsField>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              disabled={downloading}
              onClick={() => void client.aiDownloadModel().then(() => refresh())}
            >
              {downloading
                ? progress !== null
                  ? t('ai.downloading', {progress: String(progress)})
                  : t('ai.downloadingNoPct')
                : t('ai.downloadDefault')}
            </Button>
            {download?.error && <span className="text-xs text-destructive">{download.error}</span>}
            {download?.done && <span className="text-xs text-muted-foreground">{t('ai.downloadDone')}</span>}
          </div>
        </SettingsSection>
      )}

      {(provider === 'mlx' || provider === 'openai') && (
        <SettingsSection title={t('ai.endpoint')}>
          <SettingsField label={t('ai.baseUrl')} hint={provider === 'mlx' ? t('ai.mlxUrlHint') : t('ai.openaiUrlHint')}>
            <input
              className={fieldClass}
              value={draft.baseUrl ?? ''}
              placeholder={provider === 'mlx' ? 'http://127.0.0.1:8080' : 'http://127.0.0.1:11434'}
              onChange={(e) => setDraft({...draft, baseUrl: e.target.value})}
              onBlur={() => void apply(draft)}
            />
          </SettingsField>
          <SettingsField label={t('ai.modelName')} hint={provider === 'mlx' ? t('ai.mlxModelHint') : t('ai.openaiModelHint')}>
            <input
              className={fieldClass}
              value={draft.model ?? ''}
              placeholder={provider === 'mlx' ? 'mlx-community/Qwen2.5-1.5B-Instruct-4bit' : 'qwen2.5:1.5b'}
              onChange={(e) => setDraft({...draft, model: e.target.value})}
              onBlur={() => void apply(draft)}
            />
          </SettingsField>
        </SettingsSection>
      )}

      <SettingsSection title={t('ai.search')} description={t('ai.searchHint')}>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={indexing}
            onClick={() => {
              setIndexing(true);
              void client
                .aiIndex()
                .then(() => refresh())
                .finally(() => setIndexing(false));
            }}
          >
            {indexing ? t('ai.indexing') : t('ai.reindex')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {status?.index.builtAt ? t('ai.indexed', {pages: String(status.index.pages)}) : t('ai.notIndexed')}
          </span>
        </div>
      </SettingsSection>
    </SettingsScreen>
  );
}
