import {useEffect, useRef, useState} from 'react';
import {ArrowUp, Bot, Brain, ChevronDown, ChevronRight, ClipboardCheck, Loader2, Plus, Square} from 'lucide-react';
import type {AgentChatEvent, AgentChatMessage, AiEffort, StoredSuggestion} from '@open-book/sdk';
import {Button} from '@/components/ui/button';
import {Select} from '@/components/ui/select';
import {useData} from '@/data';
import type {TKey} from '@/i18n';
import {useHud, useNavigation, useTranslation} from '@/providers';
import {REVIEW_PANE_ID} from '@/lib/homePage';
import {setReviewTarget} from '@/lib/reviewPane';
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

/** One rendered entry in the thread (richer than the wire conversation). */
type ThreadItem =
  | {kind: 'user'; text: string}
  | {kind: 'assistant'; text: string}
  | {kind: 'reasoning'; text: string; expanded?: boolean}
  | {kind: 'tool'; name: string; detail?: string; running: boolean; result?: string; expanded?: boolean}
  | {kind: 'suggestions'; suggestions: StoredSuggestion[]}
  | {kind: 'error'; text: string};

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

export function AgentPanel() {
  const {setHud} = useHud();
  const {t} = useTranslation();
  const client = useData();
  const {openInSplit, closeSplit, currentPageId} = useNavigation();
  const [thread, setThread] = useState<ThreadItem[]>([]);
  const [conversation, setConversation] = useState<AgentChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [engineReady, setEngineReady] = useState(true);
  const [effort, setEffort] = useState<AiEffort>('med');
  const [thinking, setThinking] = useState(true);
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
    setBusy(false);
    inputRef.current?.focus();
  };

  const handleEvent = (event: AgentChatEvent): void => {
    if (event.type === 'tool') {
      setThread((items) => [...items, {kind: 'tool', name: event.name, detail: argSummary(event.args), running: true}]);
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
      setThread((items) => [...items, {kind: 'reasoning', text: event.text}]);
    } else if (event.type === 'suggestions') {
      if (event.suggestions.length > 0) {
        setThread((items) => [...items, {kind: 'suggestions', suggestions: event.suggestions}]);
      }
    } else if (event.type === 'final') {
      setThread((items) => [...items, {kind: 'assistant', text: event.text}]);
      setConversation((turns) => [...turns, {role: 'assistant', content: event.text}]);
    } else {
      setThread((items) => [...items, {kind: 'error', text: t('agent.error', {error: event.error})}]);
    }
  };

  const send = (): void => {
    const text = input.trim();
    if (!text || busy) return;
    const turns: AgentChatMessage[] = [...conversation, {role: 'user', content: text}];
    setConversation(turns);
    setThread((items) => [...items, {kind: 'user', text}]);
    setInput('');
    setBusy(true);
    const abort = new AbortController();
    abortRef.current = abort;
    void client
      .agentChat(turns, handleEvent, {
        signal: abort.signal,
        effort,
        thinking,
        // The agent grounds replies in the page the user is viewing + their
        // current selection, on top of whatever they typed.
        pageId: currentPageId ?? undefined,
        selection: lastSelection() || undefined,
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        setThread((items) => [...items, {kind: 'error', text: t('agent.error', {error: err instanceof Error ? err.message : String(err)})}]);
      })
      .finally(() => setBusy(false));
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
          return (
            <div
              key={i}
              data-agent-item={item.kind}
              className={cn(
                'max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
                item.kind === 'user' && 'self-end bg-primary text-primary-foreground',
                item.kind === 'assistant' && 'self-start bg-accent/50',
                item.kind === 'error' && 'self-start border border-destructive/40 text-destructive',
              )}
            >
              {item.text}
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
          <Select
            inputSize="sm"
            value={effort}
            onChange={(e) => setEffort(e.target.value as AiEffort)}
            wrapperClassName="w-[110px]"
            data-agent-effort
            aria-label={t('ai.effort')}
          >
            {EFFORTS.map((e) => (
              <option key={e.value} value={e.value}>
                {t(e.key)}
              </option>
            ))}
          </Select>
          <button
            type="button"
            data-agent-thinking
            aria-pressed={thinking}
            onClick={() => setThinking((v) => !v)}
            title={t('agent.thinkingToggle')}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors',
              thinking ? 'border-ring bg-accent/40 text-foreground' : 'border-border text-muted-foreground hover:bg-hover',
            )}
          >
            <Brain className="size-3.5" />
            {t('agent.thinkingToggle')}
          </button>
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

export default AgentPanel;
