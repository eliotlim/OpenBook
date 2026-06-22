import {useEffect, useRef, useState} from 'react';
import {ArrowUp, Bot, Brain, Check, ChevronDown, ChevronRight, ClipboardCheck, Loader2, Pencil, Plus, ShieldCheck, Sparkles, Square} from 'lucide-react';
import {
  providerSettings,
  type AgentChatEvent,
  type AgentChatMessage,
  type AiConfig,
  type AiEffort,
  type AiProvider,
  type InterviewStep,
  type StoredSuggestion,
} from '@book.dev/sdk';
import {Button} from '@/components/ui/button';
import {Markdown} from '@/components/ui/markdown';
import {Popover, PopoverContent, PopoverTrigger} from '@/components/ui/popover';
import {useData} from '@/data';
import type {TKey} from '@/i18n';
import {useHud, useNavigation, useTranslation} from '@/providers';
import {HOME_PAGE_ID, REVIEW_PANE_ID} from '@/lib/homePage';
import {setReviewTarget} from '@/lib/reviewPane';
import {aiBridge} from '@/lib/aiBridge';
import {lastSelection} from '@/lib/selection';
import {cn} from '@/lib/utils';

/**
 * The workspace assistant: a docked chat panel over the server's agent
 * harness. Each reply streams as steps — tool calls render as chips while
 * they run (click one to see what the tool returned), reasoning lands as a
 * collapsible block, and the grounded answer lands as an assistant bubble.
 * When the agent proposes WRITES, it persists them as SUGGESTIONS (never
 * applied) and a summary card appears with a "Review" button that opens the
 * Review side pane to accept/reject them. The agent needs a configured AI
 * engine; with none, the panel links straight to Settings → AI.
 */

/** One rendered entry in the thread (richer than the wire conversation). The
 *  `streaming` flag marks the assistant/reasoning item currently being filled in
 *  token-by-token, so the next chunk appends to it instead of starting a new one. */
type ThreadItem =
  | {kind: 'user'; text: string}
  | {kind: 'assistant'; text: string; streaming?: boolean}
  | {kind: 'reasoning'; text: string; expanded?: boolean; streaming?: boolean}
  | {kind: 'tool'; name: string; detail?: string; running: boolean; result?: string; expanded?: boolean}
  | {kind: 'suggestions'; suggestions: StoredSuggestion[]}
  /** The agent asked to apply edits directly; awaiting allow/deny. */
  | {kind: 'permission'; summary: string; resolved?: 'allowed' | 'denied'}
  /** The agent posed a multi-step interview; `resolved` once answers were sent. */
  | {kind: 'interview'; title?: string; steps: InterviewStep[]; resolved?: boolean}
  /** Edits the agent applied directly (granted access). */
  | {kind: 'applied'; text: string}
  | {kind: 'error'; text: string};

/** Clear the `streaming` flag on any in-progress assistant/reasoning items. */
const settle = (items: ThreadItem[]): ThreadItem[] =>
  items.map((it) => ((it.kind === 'assistant' || it.kind === 'reasoning') && it.streaming ? {...it, streaming: false} : it));

/**
 * Append a streamed chunk to the trailing item of `kind` when it is still
 * streaming, else start a new streaming item — settling any in-progress item of
 * the other kind first (answer and reasoning never interleave within a turn).
 */
const appendStream = (items: ThreadItem[], kind: 'assistant' | 'reasoning', text: string): ThreadItem[] => {
  const base = items.map((it) =>
    (it.kind === 'assistant' || it.kind === 'reasoning') && it.streaming && it.kind !== kind ? {...it, streaming: false} : it,
  );
  const last = base[base.length - 1];
  if (last && last.kind === kind && last.streaming) {
    return [...base.slice(0, -1), {...last, text: last.text + text}];
  }
  return [...base, kind === 'assistant' ? {kind: 'assistant', text, streaming: true} : {kind: 'reasoning', text, streaming: true}];
};

/** A one-line human summary of a tool call's arguments. */
const argSummary = (args: Record<string, unknown>): string | undefined => {
  const value = args.query ?? args.title ?? args.name ?? args.pageId;
  return typeof value === 'string' && value.trim() ? value : undefined;
};

const SUGGESTION_KEYS: TKey[] = ['agent.suggestion1', 'agent.suggestion2', 'agent.suggestion3'];
const EFFORTS: Array<{value: AiEffort; key: TKey}> = [
  {value: 'low', key: 'agent.effortLow'},
  {value: 'med', key: 'agent.effortMed'},
  {value: 'high', key: 'agent.effortHigh'},
];

/** Friendly model presets per provider for the conversation picker. Providers
 *  with free-form model ids (llama/mlx/openai) have none — the custom field
 *  below the presets covers them. */
const MODEL_PRESETS: Partial<Record<AiProvider, Array<{value: string; label: string}>>> = {
  claude: [
    {value: 'claude-opus-4-8', label: 'Opus 4.8'},
    {value: 'claude-sonnet-4-6', label: 'Sonnet 4.6'},
    {value: 'claude-haiku-4-5', label: 'Haiku 4.5'},
  ],
};

export function AgentPanel() {
  const {setHud} = useHud();
  const {t} = useTranslation();
  const client = useData();
  // Act on the PRIMARY (left) pane's document, not the focused pane — opening
  // the assistant focuses its own (secondary) pane, so `currentPageId` would be
  // the agent pane itself. The home pseudo-page carries no document.
  const {openInSplit, closeSplit, primaryPageId} = useNavigation();
  const targetPageId = primaryPageId && primaryPageId !== HOME_PAGE_ID ? primaryPageId : undefined;
  const [thread, setThread] = useState<ThreadItem[]>([]);
  const [conversation, setConversation] = useState<AgentChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [engineReady, setEngineReady] = useState(true);
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [provider, setProviderState] = useState<AiProvider>('off');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<AiEffort>('med');
  const [thinking, setThinking] = useState(true);
  // Sticky once the agent's "apply directly" request is granted this conversation.
  const [directEdits, setDirectEdits] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const close = () => closeSplit();
  const openAiSettings = () =>
    setHud((draft) => {
      draft.settings.open = true;
      draft.settings.tab = 'ai';
      return draft;
    });

  // Surface a "no engine" hint up front, and adopt the configured agent
  // defaults (effort / thinking) so the controls reflect Settings → AI.
  useEffect(() => {
    inputRef.current?.focus();
    void client
      .aiStatus()
      .then((status) => {
        setEngineReady(status.ready);
        setConfig(status.config);
        setProviderState(status.config.provider);
        setModel(providerSettings(status.config, status.config.provider).model ?? '');
        if (status.config.effort) setEffort(status.config.effort);
        if (typeof status.config.thinking === 'boolean') setThinking(status.config.thinking);
      })
      .catch(() => setEngineReady(false));
  }, [client]);

  // Keep the latest step in view as the run streams.
  useEffect(() => {
    scrollRef.current?.scrollTo({top: scrollRef.current.scrollHeight, behavior: 'smooth'});
  }, [thread, busy]);

  // Abandon an in-flight run when the pane unmounts (closes).
  useEffect(() => () => abortRef.current?.abort(), []);

  const stop = (): void => {
    abortRef.current?.abort();
    setBusy(false);
  };

  const reset = (): void => {
    abortRef.current?.abort();
    setThread([]);
    setConversation([]);
    setDirectEdits(false);
    setBusy(false);
    inputRef.current?.focus();
  };

  const handleEvent = (event: AgentChatEvent): void => {
    if (event.type === 'token') {
      // A live answer chunk — append to the streaming assistant bubble.
      setThread((items) => appendStream(items, 'assistant', event.text));
    } else if (event.type === 'tool') {
      setThread((items) => [...settle(items), {kind: 'tool', name: event.name, detail: argSummary(event.args), running: true}]);
    } else if (event.type === 'tool_result') {
      setThread((items) => {
        const next = [...items];
        for (let i = next.length - 1; i >= 0; i -= 1) {
          const item = next[i];
          if (item.kind === 'tool' && item.running) {
            next[i] = {...item, running: false, result: event.result};
            break;
          }
        }
        return next;
      });
    } else if (event.type === 'reasoning') {
      // Reasoning arrives whole (JSON protocol) or chunked (streaming); either
      // way accumulate into a single collapsible block per burst.
      setThread((items) => appendStream(items, 'reasoning', event.text));
    } else if (event.type === 'suggestions') {
      if (event.suggestions.length > 0) {
        setThread((items) => [...items, {kind: 'suggestions', suggestions: event.suggestions}]);
      }
    } else if (event.type === 'permission_request') {
      setThread((items) => [...settle(items), {kind: 'permission', summary: event.summary}]);
    } else if (event.type === 'interview') {
      setThread((items) => [...settle(items), {kind: 'interview', title: event.title, steps: event.steps}]);
    } else if (event.type === 'apply') {
      // The user granted direct edits: replay the proposals through the editor
      // bridge (CRDT-first, server fallback) — the same path an accepted
      // suggestion takes — and report how many landed.
      void aiBridge
        .applyProposals(event.proposals)
        .then((res) => {
          const text =
            res.failed.length > 0
              ? t('agent.appliedPartial', {applied: res.applied, failed: res.failed.length})
              : t('agent.applied', {count: res.applied});
          setThread((items) => [...items, {kind: 'applied', text}]);
        })
        .catch(() => setThread((items) => [...items, {kind: 'error', text: t('agent.applyFailed')}]));
    } else if (event.type === 'final') {
      // Replace the streamed answer with the authoritative final text (it was
      // streamed live on the native path; on the JSON path it arrives only now).
      setThread((items) => {
        const settled = settle(items);
        for (let i = settled.length - 1; i >= 0; i -= 1) {
          if (settled[i].kind === 'assistant') {
            const next = [...settled];
            next[i] = {kind: 'assistant', text: event.text};
            return next;
          }
          // A non-answer step (tool/suggestions) between us and any streamed
          // bubble means this turn produced no streamed answer — append fresh.
          if (settled[i].kind === 'tool' || settled[i].kind === 'reasoning') break;
        }
        return [...settled, {kind: 'assistant', text: event.text}];
      });
      setConversation((turns) => [...turns, {role: 'assistant', content: event.text}]);
    } else {
      setThread((items) => [...settle(items), {kind: 'error', text: t('agent.error', {error: event.error})}]);
    }
  };

  // Stream one agent run over `turns`. `direct` carries the edit-access grant for
  // this run (passed explicitly so a freshly-granted permission applies at once,
  // before the `directEdits` state has flushed).
  const runAgent = (turns: AgentChatMessage[], direct: boolean): void => {
    setBusy(true);
    const abort = new AbortController();
    abortRef.current = abort;
    void client
      .agentChat(turns, handleEvent, {
        signal: abort.signal,
        provider,
        model: model || undefined,
        effort,
        thinking,
        // The agent grounds replies in the page in the primary pane + their
        // current selection, on top of whatever they typed.
        pageId: targetPageId,
        selection: lastSelection() || undefined,
        allowDirectEdits: direct,
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        setThread((items) => [...items, {kind: 'error', text: t('agent.error', {error: err instanceof Error ? err.message : String(err)})}]);
      })
      .finally(() => setBusy(false));
  };

  // Append a user turn and run the agent. Used by the composer and by the
  // interactive cards (permission grant / interview answers) to resume the agent.
  const sendUser = (text: string, direct = directEdits): void => {
    if (busy) return;
    const turns: AgentChatMessage[] = [...conversation, {role: 'user', content: text}];
    setConversation(turns);
    setThread((items) => [...items, {kind: 'user', text}]);
    runAgent(turns, direct);
  };

  const send = (): void => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    sendUser(text);
  };

  // Resolve the agent's request to edit directly: granting flips the sticky flag
  // and resumes the agent with edit access; declining keeps the review flow.
  const resolvePermission = (index: number, allow: boolean): void => {
    if (busy) return;
    setThread((items) => items.map((it, i) => (i === index && it.kind === 'permission' ? {...it, resolved: allow ? 'allowed' : 'denied'} : it)));
    if (allow) setDirectEdits(true);
    sendUser(allow ? t('agent.permissionGrantedMsg') : t('agent.permissionDeniedMsg'), allow);
  };

  // The user finished the interview: send their answers back as a tidy message.
  const submitInterview = (index: number, answers: Array<{question: string; answer: string}>): void => {
    if (busy) return;
    setThread((items) => items.map((it, i) => (i === index && it.kind === 'interview' ? {...it, resolved: true} : it)));
    const body = answers.map((a) => `- ${a.question}\n  ${a.answer || '(no answer)'}`).join('\n');
    sendUser(`${t('agent.interviewAnswersHeader')}\n${body}`);
  };

  const toggleExpand = (index: number): void =>
    setThread((items) =>
      items.map((item, i) =>
        i === index && (item.kind === 'tool' || item.kind === 'reasoning') ? {...item, expanded: !item.expanded} : item,
      ),
    );

  // The agent persists WRITES as suggestions (never applied). Open the Review
  // side pane to accept/reject them, focusing the first of the batch.
  const openReview = (suggestions: StoredSuggestion[]): void => {
    if (suggestions.length === 0) return;
    setReviewTarget(suggestions[0].pageId, {suggestionId: suggestions[0].id});
    openInSplit(REVIEW_PANE_ID);
  };

  // The providers worth offering in the drawer: the configured default plus any
  // other provider that has a model (or a Claude key) set up in Settings → AI.
  const providerOptions: AiProvider[] = (() => {
    if (!config) return provider === 'off' ? [] : [provider];
    const picks = new Set<AiProvider>();
    if (config.provider !== 'off') picks.add(config.provider);
    for (const p of ['llama', 'mlx', 'openai', 'claude'] as AiProvider[]) {
      const s = providerSettings(config, p);
      if (s.model || (p === 'claude' && s.apiKey)) picks.add(p);
    }
    return [...picks];
  })();
  // Switching provider in the drawer pre-fills that provider's configured model.
  const changeProvider = (p: AiProvider): void => {
    setProviderState(p);
    setModel(config ? providerSettings(config, p).model ?? '' : '');
  };

  // The compact "provider · model (effort) · Reasoning" summary on the footer
  // bar, which opens the picker popover. Short provider name falls back to the
  // full label for providers without a short form (e.g. mock).
  const providerShortLabel = (p: AiProvider): string => {
    const short = t(`ai.providerShort.${p}` as TKey);
    return short === `ai.providerShort.${p}` ? t(`ai.provider.${p}` as TKey) : short;
  };
  const presets = MODEL_PRESETS[provider];
  const effortLabel = t(EFFORTS.find((e) => e.value === effort)?.key ?? 'agent.effortMed');
  const modelLabel = presets?.find((m) => m.value === model)?.label ?? (model || t('agent.modelAuto'));
  const barSummary = [providerShortLabel(provider), `${modelLabel} (${effortLabel})`, ...(thinking ? [t('agent.thinkingToggle')] : [])].join('  ·  ');

  return (
    <div data-agent-panel aria-label={t('agent.title')} className="flex h-full flex-col bg-sheet-1">
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Bot className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="flex-1 truncate text-sm font-medium">{t('agent.title')}</h2>
        <Button size="icon" variant="ghost" className="size-7" onClick={reset} title={t('agent.reset')} aria-label={t('agent.reset')}>
          <Plus className="size-4" />
        </Button>
      </header>

      <div
        ref={scrollRef}
        className={cn('flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3', thread.length === 0 && 'justify-center')}
      >
        {!engineReady && (
          <div data-agent-not-ready className="flex flex-col gap-2 rounded-md border border-border bg-accent/30 px-3 py-2.5">
            <p className="text-xs text-muted-foreground">{t('agent.notReady')}</p>
            <Button size="sm" variant="outline" className="self-start" onClick={openAiSettings}>
              {t('agent.openSettings')}
            </Button>
          </div>
        )}
        {thread.length === 0 && (
          <div className="flex flex-col gap-2 py-4">
            <p className="px-1 text-center text-sm text-muted-foreground">{t('agent.hint')}</p>
            <div className="mt-2 flex flex-col gap-1.5">
              {SUGGESTION_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  data-agent-suggestion
                  onClick={() => {
                    setInput(t(key));
                    inputRef.current?.focus();
                  }}
                  className="rounded-md border border-border px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </div>
        )}
        {thread.map((item, i) => {
          if (item.kind === 'tool') {
            const Chevron = item.expanded ? ChevronDown : ChevronRight;
            return (
              <div key={i} className="flex max-w-full flex-col gap-1 self-start">
                <button
                  type="button"
                  data-agent-tool={item.name}
                  onClick={() => toggleExpand(i)}
                  disabled={item.result === undefined}
                  aria-expanded={item.expanded ?? false}
                  className={cn(
                    'inline-flex max-w-full items-center gap-1.5 self-start rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground',
                    item.result !== undefined && 'transition-colors hover:bg-hover hover:text-foreground',
                  )}
                >
                  {item.running ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Chevron className="size-3" aria-hidden />}
                  <span className="truncate">
                    {t(`agent.tool.${item.name}` as TKey)}
                    {item.detail ? ` · ${item.detail}` : ''}
                  </span>
                </button>
                {item.expanded && item.result !== undefined && (
                  <pre
                    data-agent-tool-result
                    className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background/60 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground"
                  >
                    {item.result}
                  </pre>
                )}
              </div>
            );
          }
          if (item.kind === 'reasoning') {
            const Chevron = item.expanded ? ChevronDown : ChevronRight;
            return (
              <div key={i} className="flex max-w-full flex-col gap-1 self-start">
                <button
                  type="button"
                  data-agent-reasoning
                  onClick={() => toggleExpand(i)}
                  aria-expanded={item.expanded ?? false}
                  className="inline-flex max-w-full items-center gap-1.5 self-start rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
                >
                  <Brain className="size-3" aria-hidden />
                  <Chevron className="size-3" aria-hidden />
                  <span className="truncate">{t('agent.reasoning')}</span>
                </button>
                {item.expanded && (
                  <pre
                    data-agent-reasoning-body
                    className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-background/60 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground"
                  >
                    {item.text}
                  </pre>
                )}
              </div>
            );
          }
          if (item.kind === 'suggestions') {
            return (
              <div
                key={i}
                data-agent-suggestions
                className="flex max-w-full flex-col gap-2 self-start rounded-lg border border-border bg-background/60 px-3 py-2.5"
              >
                <p className="text-xs font-medium">{t('agent.suggestionsTitle', {count: item.suggestions.length})}</p>
                <p className="text-[11px] text-muted-foreground">{t('agent.suggestionsHint')}</p>
                <ul className="flex flex-col gap-1.5">
                  {item.suggestions.map((s) => (
                    <li key={s.id} className="rounded-md border border-border bg-sheet-1 px-2.5 py-1.5">
                      <p className="text-xs font-medium">
                        {typeof s.payload.summary === 'string' ? s.payload.summary : s.kind}
                      </p>
                      {(s.before || s.after) && (
                        <p className="mt-0.5 break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
                          {s.before && <span className="text-destructive/80">- {s.before}</span>}
                          {s.before && s.after && ' '}
                          {s.after && <span className="text-emerald-600 dark:text-emerald-400">+ {s.after}</span>}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                <Button size="sm" data-agent-review className="self-start" onClick={() => openReview(item.suggestions)}>
                  <ClipboardCheck className="mr-1 size-3.5" />
                  {t('agent.review')}
                </Button>
              </div>
            );
          }
          if (item.kind === 'permission') {
            return (
              <div
                key={i}
                data-agent-permission
                className="flex max-w-full flex-col gap-2 self-start rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5"
              >
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <ShieldCheck className="size-3.5 text-primary" aria-hidden />
                  {t('agent.permissionTitle')}
                </p>
                <p className="text-[11px] text-muted-foreground">{t('agent.permissionHint', {summary: item.summary})}</p>
                {item.resolved ? (
                  <p className="text-[11px] font-medium text-muted-foreground">
                    {item.resolved === 'allowed' ? t('agent.permissionAllowed') : t('agent.permissionDeclined')}
                  </p>
                ) : (
                  <div className="flex gap-2">
                    <Button size="sm" data-agent-permission-allow onClick={() => resolvePermission(i, true)} disabled={busy}>
                      {t('agent.permissionAllow')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => resolvePermission(i, false)} disabled={busy}>
                      {t('agent.permissionKeepReview')}
                    </Button>
                  </div>
                )}
              </div>
            );
          }
          if (item.kind === 'interview') {
            return (
              <InterviewCard
                key={i}
                title={item.title}
                steps={item.steps}
                resolved={item.resolved}
                disabled={busy}
                onSubmit={(answers) => submitInterview(i, answers)}
              />
            );
          }
          if (item.kind === 'applied') {
            return (
              <div
                key={i}
                data-agent-applied
                className="inline-flex items-center gap-1.5 self-start rounded-md border border-emerald-500/30 bg-emerald-500/5 px-2.5 py-1 text-[11px] text-emerald-700 dark:text-emerald-300"
              >
                <Check className="size-3.5" aria-hidden />
                {item.text}
              </div>
            );
          }
          return (
            <div
              key={i}
              data-agent-item={item.kind}
              className={cn(
                'max-w-[90%] rounded-lg px-3 py-2 text-sm',
                item.kind === 'user' && 'self-end whitespace-pre-wrap bg-primary text-primary-foreground',
                item.kind === 'assistant' && 'self-start bg-accent/50',
                item.kind === 'error' && 'self-start whitespace-pre-wrap border border-destructive/40 text-destructive',
              )}
            >
              {item.kind === 'assistant' ? <Markdown content={item.text} /> : item.text}
            </div>
          );
        })}
        {busy && (
          <span className="inline-flex items-center gap-1.5 self-start px-1 text-xs text-muted-foreground" data-agent-busy>
            <Loader2 className="size-3 animate-spin" aria-hidden />
            {t('agent.thinking')}
          </span>
        )}
      </div>

      <footer className="flex flex-col gap-1.5 border-t border-border p-2">
        <textarea
          ref={inputRef}
          data-agent-input
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            } else if (e.key === 'Escape') {
              close();
            }
          }}
          placeholder={t('agent.placeholder')}
          aria-label={t('agent.placeholder')}
          className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-hidden focus:border-ring"
        />
        <div className="flex items-center gap-2">
          {providerOptions.length > 0 && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-agent-modelbar
                  aria-label={t('agent.modelSettings')}
                  title={t('agent.modelSettings')}
                  className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-hover hover:text-foreground"
                >
                  <Sparkles className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{barSummary}</span>
                  <ChevronDown className="size-3 shrink-0" aria-hidden />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" side="top" className="w-64 p-2 text-sm">
                <div className="flex flex-col gap-0.5" data-agent-provider aria-label={t('agent.provider')}>
                  <p className="px-1 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('agent.provider')}</p>
                  {providerOptions.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => changeProvider(p)}
                      className={cn(
                        'flex items-center justify-between gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-hover',
                        p === provider && 'bg-accent/50',
                      )}
                    >
                      <span className="truncate">{providerShortLabel(p)}</span>
                      {p === provider && <Check className="size-3.5 shrink-0" aria-hidden />}
                    </button>
                  ))}
                </div>
                {presets && presets.length > 0 && (
                  <div className="mt-2 flex flex-col gap-0.5">
                    <p className="px-1 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('agent.model')}</p>
                    {presets.map((m) => (
                      <button
                        key={m.value}
                        type="button"
                        onClick={() => setModel(m.value)}
                        className={cn(
                          'flex items-center justify-between gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-hover',
                          m.value === model && 'bg-accent/50',
                        )}
                      >
                        <span className="truncate">{m.label}</span>
                        {m.value === model && <Check className="size-3.5 shrink-0" aria-hidden />}
                      </button>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex flex-col gap-1">
                  <p className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {presets ? t('agent.modelCustom') : t('agent.model')}
                  </p>
                  <input
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={t('agent.modelPlaceholder')}
                    data-agent-model
                    aria-label={t('agent.model')}
                    className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-hidden focus:border-ring"
                  />
                </div>
                <div className="mt-2 flex flex-col gap-1">
                  <p className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('ai.effort')}</p>
                  <div className="flex gap-1" data-agent-effort aria-label={t('ai.effort')}>
                    {EFFORTS.map((e) => (
                      <button
                        key={e.value}
                        type="button"
                        onClick={() => setEffort(e.value)}
                        className={cn(
                          'flex-1 rounded-md border px-2 py-1 text-xs transition-colors',
                          effort === e.value ? 'border-ring bg-accent/40 text-foreground' : 'border-border text-muted-foreground hover:bg-hover',
                        )}
                      >
                        {t(e.key)}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  data-agent-thinking
                  aria-pressed={thinking}
                  onClick={() => setThinking((v) => !v)}
                  className={cn(
                    'mt-2 flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors',
                    thinking ? 'border-ring bg-accent/40 text-foreground' : 'border-border text-muted-foreground hover:bg-hover',
                  )}
                >
                  <Brain className="size-3.5 shrink-0" aria-hidden />
                  <span className="flex-1 text-left">{t('agent.thinkingToggle')}</span>
                  {thinking && <Check className="size-3.5 shrink-0" aria-hidden />}
                </button>
              </PopoverContent>
            </Popover>
          )}
          <span className="flex-1" />
          {busy ? (
            <Button size="icon" variant="outline" className="size-7" onClick={stop} title={t('agent.stop')} aria-label={t('agent.stop')}>
              <Square className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-7"
              data-agent-send
              onClick={send}
              disabled={!input.trim()}
              title={t('agent.send')}
              aria-label={t('agent.send')}
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}

/**
 * The agent's `ask_user` interview: one question per step, each with options
 * (single or multi-select) and/or a typed answer. Collects the answers locally
 * and hands them back on the last step — the panel sends them as the user's
 * next message so the agent can continue.
 */
function InterviewCard({
  title,
  steps,
  resolved,
  disabled,
  onSubmit,
}: {
  title?: string;
  steps: InterviewStep[];
  resolved?: boolean;
  disabled?: boolean;
  onSubmit: (answers: Array<{question: string; answer: string}>) => void;
}) {
  const {t} = useTranslation();
  const [stepIdx, setStepIdx] = useState(0);
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});

  if (resolved) {
    return (
      <div data-agent-interview className="self-start rounded-lg border border-border bg-background/60 px-3 py-2 text-[11px] text-muted-foreground">
        {t('agent.interviewSent')}
      </div>
    );
  }

  const step = steps[stepIdx];
  const sel = picks[step.id] ?? [];
  const choose = (value: string): void =>
    setPicks((prev) => {
      const cur = prev[step.id] ?? [];
      if (step.multiple) return {...prev, [step.id]: cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]};
      return {...prev, [step.id]: cur.includes(value) ? [] : [value]}; // single-select toggle/replace
    });
  const answerFor = (s: InterviewStep): string => {
    const chosen = (s.options ?? []).filter((o) => (picks[s.id] ?? []).includes(o.value)).map((o) => o.label);
    const typed = (texts[s.id] ?? '').trim();
    return [chosen.join(', '), typed].filter(Boolean).join(' — ');
  };
  const last = stepIdx === steps.length - 1;
  const advance = (): void => {
    if (last) onSubmit(steps.map((s) => ({question: s.question, answer: answerFor(s)})));
    else setStepIdx((n) => n + 1);
  };

  return (
    <div data-agent-interview className="flex w-full max-w-full flex-col gap-2 self-start rounded-lg border border-border bg-background/60 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <Pencil className="size-3.5 text-primary" aria-hidden />
          {title || t('agent.interviewTitle')}
        </p>
        <span className="shrink-0 text-[10px] text-muted-foreground">{t('agent.interviewStep', {current: stepIdx + 1, total: steps.length})}</span>
      </div>
      <p className="text-sm">{step.question}</p>
      {step.options && step.options.length > 0 && (
        <div className="flex flex-col gap-1">
          {step.options.map((o) => {
            const picked = sel.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                data-agent-interview-option
                onClick={() => choose(o.value)}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors',
                  picked ? 'border-primary bg-primary/10' : 'border-border hover:bg-hover',
                )}
              >
                <span
                  className={cn(
                    'flex size-3.5 shrink-0 items-center justify-center border',
                    step.multiple ? 'rounded' : 'rounded-full',
                    picked ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
                  )}
                >
                  {picked && <Check className="size-2.5" />}
                </span>
                <span className="truncate">{o.label}</span>
              </button>
            );
          })}
        </div>
      )}
      {step.freeText && (
        <textarea
          rows={2}
          value={texts[step.id] ?? ''}
          onChange={(e) => setTexts((prev) => ({...prev, [step.id]: e.target.value}))}
          placeholder={t('agent.interviewPlaceholder')}
          aria-label={step.question}
          className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-hidden focus:border-ring"
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="ghost" disabled={stepIdx === 0 || disabled} onClick={() => setStepIdx((n) => Math.max(0, n - 1))}>
          {t('agent.interviewBack')}
        </Button>
        <Button size="sm" data-agent-interview-next disabled={disabled} onClick={advance}>
          {last ? t('agent.interviewSubmit') : t('agent.interviewNext')}
        </Button>
      </div>
    </div>
  );
}

export default AgentPanel;
