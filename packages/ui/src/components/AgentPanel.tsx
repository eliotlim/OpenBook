import {useEffect, useRef, useState} from 'react';
import {ArrowUp, Bot, ChevronDown, ChevronRight, Loader2, Plus, Square, X} from 'lucide-react';
import type {AgentChatEvent, AgentChatMessage} from '@open-book/sdk';
import {Button} from '@/components/ui/button';
import {useData} from '@/data';
import type {TKey} from '@/i18n';
import {useHud, useTranslation} from '@/providers';
import {cn} from '@/lib/utils';

/**
 * The workspace assistant: a docked chat panel over the server's agent
 * harness. Each reply streams as steps — tool calls render as chips while
 * they run (click one to see what the tool returned), the grounded answer
 * lands as an assistant bubble. The agent needs a configured AI engine;
 * with none, the panel links straight to Settings → AI.
 */

/** One rendered entry in the thread (richer than the wire conversation). */
type ThreadItem =
  | {kind: 'user'; text: string}
  | {kind: 'assistant'; text: string}
  | {kind: 'tool'; name: string; detail?: string; running: boolean; result?: string; expanded?: boolean}
  | {kind: 'error'; text: string};

/** A one-line human summary of a tool call's arguments. */
const argSummary = (args: Record<string, unknown>): string | undefined => {
  const value = args.query ?? args.title ?? args.pageId;
  return typeof value === 'string' && value.trim() ? value : undefined;
};

const SUGGESTION_KEYS: TKey[] = ['agent.suggestion1', 'agent.suggestion2', 'agent.suggestion3'];

export function AgentPanel() {
  const {hud, setHud} = useHud();
  const {t} = useTranslation();
  const client = useData();
  const [thread, setThread] = useState<ThreadItem[]>([]);
  const [conversation, setConversation] = useState<AgentChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [engineReady, setEngineReady] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const open = hud.agent.open;
  const close = () =>
    setHud((draft) => {
      draft.agent.open = false;
      return draft;
    });
  const openAiSettings = () =>
    setHud((draft) => {
      draft.settings.open = true;
      draft.settings.tab = 'ai';
      return draft;
    });

  // Surface a "no engine" hint up front rather than on the first failed ask,
  // and put the cursor where the conversation starts.
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    void client
      .aiStatus()
      .then((status) => setEngineReady(status.ready))
      .catch(() => setEngineReady(false));
  }, [open, client]);

  // Keep the latest step in view as the run streams.
  useEffect(() => {
    scrollRef.current?.scrollTo({top: scrollRef.current.scrollHeight, behavior: 'smooth'});
  }, [thread, busy]);

  // Abandon an in-flight run when the panel closes or unmounts.
  useEffect(() => {
    if (!open) abortRef.current?.abort();
    return () => abortRef.current?.abort();
  }, [open]);

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
      .agentChat(turns, handleEvent, {signal: abort.signal})
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        setThread((items) => [...items, {kind: 'error', text: t('agent.error', {error: err instanceof Error ? err.message : String(err)})}]);
      })
      .finally(() => setBusy(false));
  };

  const toggleTool = (index: number): void =>
    setThread((items) => items.map((item, i) => (i === index && item.kind === 'tool' ? {...item, expanded: !item.expanded} : item)));

  if (!open) return null;

  return (
    <aside
      data-agent-panel
      aria-label={t('agent.title')}
      className="flex w-[340px] shrink-0 flex-col border-l border-border bg-sheet-1 animate-in fade-in slide-in-from-right-4 duration-200 print:hidden"
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Bot className="size-4 text-muted-foreground" aria-hidden />
        <h2 className="flex-1 truncate text-sm font-medium">{t('agent.title')}</h2>
        <Button size="icon" variant="ghost" className="size-7" onClick={reset} title={t('agent.reset')} aria-label={t('agent.reset')}>
          <Plus className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" className="size-7" onClick={close} title={t('agent.close')} aria-label={t('agent.close')}>
          <X className="size-4" />
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
                  className="rounded-md border border-border px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
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
                  onClick={() => toggleTool(i)}
                  disabled={item.result === undefined}
                  aria-expanded={item.expanded ?? false}
                  className={cn(
                    'inline-flex max-w-full items-center gap-1.5 self-start rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground',
                    item.result !== undefined && 'transition-colors hover:bg-accent/40 hover:text-foreground',
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
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[11px] text-muted-foreground">{t('agent.inputHint')}</span>
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
    </aside>
  );
}

export default AgentPanel;
