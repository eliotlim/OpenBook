import {useCallback, useEffect, useState} from 'react';
import {Trash2} from 'lucide-react';
import {providerSettings, type AiConfig, type AiEffort, type AiProvider, type AiProviderSettings, type AiSkill, type AiStatus} from '@open-book/sdk';
import {SettingsField, SettingsScreen, SettingsSection, SettingsToggle} from '@/components/settings/primitives';
import {Button} from '@/components/ui/button';
import {Select} from '@/components/ui/select';
import {useData} from '@/data';
import {useConfirm, useTranslation} from '@/providers';
import {cn} from '@/lib/utils';

const fieldClass =
  'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-hidden focus:border-ring';

/** Providers that carry connection settings (everything except off/mock). */
const CONFIGURABLE: AiProvider[] = ['llama', 'mlx', 'openai', 'claude'];

/**
 * Migrate a legacy single-provider config (flat model/baseUrl/apiKey, which
 * belonged to the then-active provider) into the per-provider `providers` map,
 * so the UI always edits the new shape and switching the default can't lose a
 * provider's settings.
 */
function normalize(c: AiConfig): AiConfig {
  const providers: Partial<Record<AiProvider, AiProviderSettings>> = {...(c.providers ?? {})};
  const hasLegacy = c.model !== undefined || c.baseUrl !== undefined || c.apiKey !== undefined || c.autoStart !== undefined;
  if (hasLegacy && !providers[c.provider]) {
    providers[c.provider] = {model: c.model, baseUrl: c.baseUrl, apiKey: c.apiKey, autoStart: c.autoStart};
  }
  return {provider: c.provider, providers, effort: c.effort, thinking: c.thinking};
}

/**
 * Settings → AI: the optional local model engine. Everything here talks to
 * the server's /api/ai surface; nothing runs in the browser. The provider
 * choices cover the cross-platform in-process engine (llama.cpp), Apple
 * Silicon's MLX, and any OpenAI-compatible local server.
 */
export default function AiSettings() {
  const client = useData();
  const {t} = useTranslation();
  const confirm = useConfirm();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [draft, setDraft] = useState<AiConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [skills, setSkills] = useState<AiSkill[]>([]);

  const refresh = useCallback(async () => {
    try {
      const next = await client.aiStatus();
      setStatus(next);
      setDraft((d) => d ?? normalize(next.config));
    } catch {
      setStatus(null);
    }
  }, [client]);

  const refreshSkills = useCallback(async () => {
    try {
      setSkills(await client.aiSkills());
    } catch {
      setSkills([]);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    void refreshSkills();
  }, [refresh, refreshSkills]);

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
    {id: 'claude', label: t('ai.provider.claude'), hint: t('ai.provider.claudeHint')},
  ];

  // Edit one provider's stored settings (merged into draft.providers[p]); apply
  // on blur. Read through providerSettings so a not-yet-migrated config works.
  const set = (p: AiProvider, patch: Partial<AiProviderSettings>): AiConfig => ({
    ...draft,
    providers: {...draft.providers, [p]: {...providerSettings(draft, p), ...patch}},
  });
  const modelInput = (p: AiProvider, placeholder: string, hint: string) => (
    <SettingsField label={t('ai.modelName')} hint={hint}>
      <input
        className={fieldClass}
        value={providerSettings(draft, p).model ?? ''}
        placeholder={placeholder}
        onChange={(e) => setDraft(set(p, {model: e.target.value}))}
        onBlur={() => void apply(draft)}
      />
    </SettingsField>
  );

  // Every provider's connection settings, shown together so all are configurable
  // at once (the radio above only picks which is the default).
  const renderProviderConfig = (p: AiProvider) => {
    const s = providerSettings(draft, p);
    return (
      <SettingsSection key={p} title={t(`ai.providerShort.${p}` as Parameters<typeof t>[0])}>
        {p === 'llama' && (
          <>
            <SettingsField label={t('ai.modelFile')} hint={t('ai.modelFileHint')}>
              <input
                className={fieldClass}
                value={s.model ?? ''}
                placeholder="qwen2.5-1.5b-instruct-q4_k_m.gguf"
                onChange={(e) => setDraft(set(p, {model: e.target.value}))}
                onBlur={() => void apply(draft)}
              />
            </SettingsField>
            <div className="flex items-center gap-3">
              <Button size="sm" variant="outline" disabled={downloading} onClick={() => void client.aiDownloadModel().then(() => refresh())}>
                {downloading
                  ? progress !== null
                    ? t('ai.downloading', {progress: String(progress)})
                    : t('ai.downloadingNoPct')
                  : t('ai.downloadDefault')}
              </Button>
              {download?.error && <span className="text-xs text-destructive">{download.error}</span>}
              {download?.done && <span className="text-xs text-muted-foreground">{t('ai.downloadDone')}</span>}
            </div>
          </>
        )}
        {p === 'mlx' && (
          <>
            <SettingsField label={t('ai.baseUrl')} hint={t('ai.mlxUrlHint')}>
              <input
                className={fieldClass}
                value={s.baseUrl ?? ''}
                placeholder="http://127.0.0.1:8080"
                onChange={(e) => setDraft(set(p, {baseUrl: e.target.value}))}
                onBlur={() => void apply(draft)}
              />
            </SettingsField>
            {modelInput(p, 'mlx-community/Qwen2.5-1.5B-Instruct-4bit', t('ai.mlxModelHint'))}
          </>
        )}
        {p === 'openai' && (
          <>
            <SettingsField label={t('ai.baseUrl')} hint={t('ai.openaiUrlHint')}>
              <input
                className={fieldClass}
                value={s.baseUrl ?? ''}
                placeholder="http://127.0.0.1:11434"
                onChange={(e) => setDraft(set(p, {baseUrl: e.target.value}))}
                onBlur={() => void apply(draft)}
              />
            </SettingsField>
            {modelInput(p, 'qwen2.5:1.5b', t('ai.openaiModelHint'))}
          </>
        )}
        {p === 'claude' && (
          <>
            <SettingsField label={t('ai.apiKey')} hint={t('ai.apiKeyHint')}>
              <input
                type="password"
                autoComplete="off"
                className={fieldClass}
                value={s.apiKey ?? ''}
                placeholder="sk-ant-…"
                onChange={(e) => setDraft(set(p, {apiKey: e.target.value}))}
                onBlur={() => void apply(draft)}
              />
            </SettingsField>
            {modelInput(p, 'claude-sonnet-4-6', t('ai.claudeModelHint'))}
          </>
        )}
      </SettingsSection>
    );
  };

  return (
    <SettingsScreen title={t('settings.tab.ai')} description={t('ai.description')}>
      <SettingsSection title={t('ai.defaultEngine')} description={t('ai.defaultEngineHint')}>
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t('ai.providerLabel')}>
          {providers.map((p) => (
            <label
              key={p.id}
              className={cn(
                'flex cursor-pointer items-center justify-between gap-6 rounded-md border px-3.5 py-3',
                provider === p.id ? 'border-ring bg-accent/40' : 'border-border hover:bg-hover',
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

      {CONFIGURABLE.map(renderProviderConfig)}

      {provider !== 'off' && (
        <SettingsSection title={t('ai.assistant')} description={t('ai.assistantHint')}>
          <SettingsField label={t('ai.effort')} hint={t('ai.effortHint')}>
            <Select
              value={draft.effort ?? 'med'}
              wrapperClassName="w-[180px]"
              data-ai-effort
              onChange={(e) => void apply({...draft, effort: e.target.value as AiEffort})}
              disabled={busy}
            >
              <option value="low">{t('ai.effortLow')}</option>
              <option value="med">{t('ai.effortMed')}</option>
              <option value="high">{t('ai.effortHigh')}</option>
            </Select>
          </SettingsField>
          <SettingsToggle
            label={t('ai.thinking')}
            hint={t('ai.thinkingHint')}
            checked={draft.thinking ?? true}
            disabled={busy}
            onCheckedChange={(checked) => void apply({...draft, thinking: checked})}
          />
        </SettingsSection>
      )}

      <SettingsSection title={t('ai.skills')} description={t('ai.skillsHint')}>
        <SkillsEditor skills={skills} onChange={refreshSkills} confirm={confirm} />
      </SettingsSection>

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

/** The prompt/recipe skills list + an inline editor for one new skill. */
function SkillsEditor({
  skills,
  onChange,
  confirm,
}: {
  skills: AiSkill[];
  onChange: () => Promise<void>;
  confirm: ReturnType<typeof useConfirm>;
}) {
  const client = useData();
  const {t} = useTranslation();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [saving, setSaving] = useState(false);

  const reset = (): void => {
    setName('');
    setDescription('');
    setInstructions('');
    setAdding(false);
  };

  const save = async (): Promise<void> => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await client.aiSaveSkill({name, description, instructions});
      await onChange();
      reset();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (skill: AiSkill): Promise<void> => {
    if (!(await confirm({title: t('ai.skillDelete'), description: skill.name, destructive: true, confirmText: t('ai.skillDelete')}))) return;
    await client.aiDeleteSkill(skill.name);
    await onChange();
  };

  return (
    <div className="flex flex-col gap-2" data-ai-skills>
      {skills.length === 0 && !adding && <p className="text-xs text-muted-foreground">{t('ai.skillEmpty')}</p>}
      {skills.map((skill) => (
        <div key={skill.name} className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2.5">
          <span className="flex min-w-0 flex-col">
            <span className="font-mono text-sm font-medium">{skill.name}</span>
            {skill.description && <span className="text-xs text-muted-foreground">{skill.description}</span>}
          </span>
          <Button size="icon" variant="ghost" className="size-7 shrink-0" onClick={() => void remove(skill)} aria-label={t('ai.skillDelete')}>
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}

      {adding ? (
        <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-3">
          <SettingsField label={t('ai.skillName')}>
            <input className={fieldClass} value={name} placeholder={t('ai.skillNamePlaceholder')} onChange={(e) => setName(e.target.value)} />
          </SettingsField>
          <SettingsField label={t('ai.skillDescription')}>
            <input
              className={fieldClass}
              value={description}
              placeholder={t('ai.skillDescriptionPlaceholder')}
              onChange={(e) => setDescription(e.target.value)}
            />
          </SettingsField>
          <SettingsField label={t('ai.skillInstructions')}>
            <textarea
              className={cn(fieldClass, 'min-h-24 resize-y')}
              value={instructions}
              placeholder={t('ai.skillInstructionsPlaceholder')}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </SettingsField>
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={!name.trim() || saving} onClick={() => void save()}>
              {t('ai.skillSave')}
            </Button>
            <Button size="sm" variant="outline" onClick={reset}>
              {t('ai.skillCancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="self-start" onClick={() => setAdding(true)}>
          {t('ai.skillAdd')}
        </Button>
      )}
    </div>
  );
}
