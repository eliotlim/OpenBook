import {useEffect, useRef, useState} from 'react';
import {Bot, Loader2, Plus, X} from 'lucide-react';
import type {AgentChatEvent, AgentChatMessage} from '@open-book/sdk';
import {Button} from '@/components/ui/button';
import {useData} from '@/data';
import type {TKey} from '@/i18n';
import {useHud, useTranslation} from '@/providers';
import {cn} from '@/lib/utils';

/**
 * The workspace assistant: a docked chat panel over the server's agent
 * harness. Each reply streams as steps — tool calls render as chips while
 * they run, the grounded answer lands as an assistant bubble. The agent
 * needs a configured AI engine; with none, the panel points to Settings → AI.
 */

/** One rendered entry in the thread (richer than the wire conversation). */
type ThreadItem =
  | {kind: 'user'; text: string}
  | {kind: 'assistant'; text: string}
  | {kind: 'tool'; name: string; detail?: string; running: boolean}
  | {kind: 'error'; text: string};

/** A one-line human summary of a tool call's arguments. */
const argSummary = (args: Record<string, unknown>): string | undefined => {
  const value = args.query ?? args.title ?? args.pageId;
  return typeof value === 'string' && value.trim() ? value : undefined;
};

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
  const abortRef = useRef<AbortController | null>(null);

  const open = hud.agent.open;
  const close = () =>
    setHud((draft) => {
      draft.agent.open = false;
      return draft;
    });

  // Surface a "no engine" hint up front rather than on the first failed ask.
  useEffect(() => {
    if (!open) return;
    void client
      .aiStatus()
      .then((status) => setEngineReady(status.ready))
      .catch(() => setEngineReady(false));
  }, [open, client]);

  // Keep the latest step in view as the run streams.
  useEffect(() => {
    scrollRef.current?.scrollTo({top: scrollRef.current.scrollHeight});
  }, [thread, busy]);

  // Abandon an in-flight run when the panel closes or unmounts.
  useEffect(() => {
    if (!open) abortRef.current?.abort();
    return () => abortRef.current?.abort();
  }, [open]);

  const reset = (): void => {
    abortRef.current?.abort();
    setThread([]);
    setConversation([]);
    setBusy(false);
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
            next[i] = {...item, running: false};
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

  if (!open) return null;

  return (
    <aside
      data-agent-panel
      aria-label={t('agent.title')}
      className="flex w-80 shrink-0 flex-col border-l border-border bg-sheet-1 print:hidden"
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

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3">
        {!engineReady && (
          <p data-agent-not-ready className="rounded-md border border-border bg-accent/30 px-3 py-2 text-xs text-muted-foreground">
            {t('agent.notReady')}
          </p>
        )}
        {thread.length === 0 && <p className="px-1 py-4 text-center text-sm text-muted-foreground">{t('agent.hint')}</p>}
        {thread.map((item, i) => {
          if (item.kind === 'tool') {
            return (
              <span
                key={i}
                data-agent-tool={item.name}
                className="inline-flex max-w-full items-center gap-1.5 self-start rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground"
              >
                {item.running ? <Loader2 className="size-3 animate-spin" aria-hidden /> : <Bot className="size-3" aria-hidden />}
                <span className="truncate">
                  {t(`agent.tool.${item.name}` as TKey)}
                  {item.detail ? ` · ${item.detail}` : ''}
                </span>
              </span>
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

      <footer className="border-t border-border p-2">
        <textarea
          data-agent-input
          rows={2}
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={t('agent.placeholder')}
          aria-label={t('agent.placeholder')}
          className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-hidden focus:border-ring"
        />
      </footer>
    </aside>
  );
}

export default AgentPanel;
