/**
 * Reasoning extraction. Local "thinking" models (Qwen-QwQ, DeepSeek-R1, …)
 * wrap their chain-of-thought in `<think>…</think>` tags; we route those tokens
 * to a separate channel so the UI shows reasoning as a collapsible block and
 * the document only ever receives the answer. Models that don't emit think
 * tags are prompted (see {@link SCRATCHPAD_INSTRUCTION}) to write a delimited
 * scratchpad we split the same way. The splitter is a tiny streaming state
 * machine so it works token-by-token over SSE.
 */

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

/** Prompt suffix used when we want a scratchpad from a non-think-tag model. */
export const SCRATCHPAD_INSTRUCTION =
  'First reason step by step inside a section that starts with the line "### reasoning". ' +
  'Then write the line "### answer" and give ONLY the final answer below it. ' +
  'Do not repeat the reasoning in the answer section.';

const REASONING_HEADER = /(^|\n)\s*#{1,6}\s*reasoning\s*\n/i;
const ANSWER_HEADER = /(^|\n)\s*#{1,6}\s*answer\s*\n/i;

/**
 * A streaming splitter that classifies incoming tokens as reasoning or answer.
 * Handles both `<think>` tags and the `### reasoning / ### answer` scratchpad.
 * Tag/header markers themselves are swallowed (emitted on neither channel).
 *
 * Because tokens arrive in arbitrary chunks, a tag can straddle a boundary; we
 * buffer just enough trailing text (a marker's length) so a split tag is never
 * misclassified.
 */
export class ReasoningSplitter {
  private mode: 'answer' | 'thinking' = 'answer';
  /** Tail held back in case it is the prefix of a marker. */
  private pending = '';
  /** Have we seen any reasoning marker yet? (gates scratchpad detection). */
  private sawReasoning = false;
  /** Have we crossed the scratchpad "### answer" line? */
  private inScratchAnswer = false;
  private usesScratchpad = false;

  constructor(
    private readonly onAnswer: (text: string) => void,
    private readonly onReasoning: (text: string) => void,
  ) {}

  /** Feed a token (or any chunk) from the model stream. */
  push(chunk: string): void {
    this.pending += chunk;
    this.drain(false);
  }

  /** Call once the stream ends to flush any held-back tail. */
  flush(): void {
    this.drain(true);
    if (this.pending) {
      this.emit(this.pending);
      this.pending = '';
    }
  }

  private emit(text: string): void {
    if (!text) return;
    if (this.mode === 'thinking') this.onReasoning(text);
    else this.onAnswer(text);
  }

  /**
   * Process the buffer. The longest marker is `</think>` (8 chars); we never
   * emit the final `keep` chars unless `final` so a marker split across chunks
   * is matched whole on the next push.
   */
  private drain(final: boolean): void {
    const keep = final ? 0 : THINK_CLOSE.length;
    for (;;) {
      const marker = this.mode === 'thinking' ? THINK_CLOSE : THINK_OPEN;
      const at = this.pending.indexOf(marker);
      if (at !== -1) {
        this.emit(this.pending.slice(0, at));
        this.pending = this.pending.slice(at + marker.length);
        this.mode = this.mode === 'thinking' ? 'answer' : 'thinking';
        continue;
      }
      // No think tag this pass. Honour the scratchpad headers — `### reasoning`
      // is detected in answer mode, `### answer` while in the reasoning section.
      if (this.tryScratchpad()) continue;
      break;
    }
    // Emit everything except a possible trailing marker prefix.
    if (this.pending.length > keep) {
      const safe = this.pending.length - keep;
      this.emit(this.pending.slice(0, safe));
      this.pending = this.pending.slice(safe);
    }
  }

  /** Detect the `### reasoning` / `### answer` scratchpad headers in `pending`. */
  private tryScratchpad(): boolean {
    if (this.inScratchAnswer) return false;
    // Before any reasoning marker, look for the `### reasoning` opener (answer
    // mode only — a header inside a <think> block is the model's own text).
    if (!this.sawReasoning) {
      if (this.mode !== 'answer') return false;
      const m = REASONING_HEADER.exec(this.pending);
      if (!m) return false;
      this.emit(this.pending.slice(0, m.index));
      this.pending = this.pending.slice(m.index + m[0].length);
      this.sawReasoning = true;
      this.usesScratchpad = true;
      this.mode = 'thinking';
      return true;
    }
    // Inside the scratchpad reasoning section — watch for the `### answer` close.
    const a = ANSWER_HEADER.exec(this.pending);
    if (!a) return false;
    this.emit(this.pending.slice(0, a.index));
    this.pending = this.pending.slice(a.index + a[0].length);
    this.inScratchAnswer = true;
    this.mode = 'answer';
    return true;
  }

  /** Whether the scratchpad fallback fired (used for diagnostics/tests). */
  get scratchpadUsed(): boolean {
    return this.usesScratchpad;
  }
}

/**
 * Split a complete (non-streamed) reply into reasoning + answer. Used by the
 * agent loop, which generates whole replies and then classifies them. Strips
 * `<think>` blocks and the scratchpad reasoning section, returning the answer
 * the agent should act on plus the reasoning to surface.
 */
export function splitReasoning(raw: string): {answer: string; reasoning: string} {
  let answer = '';
  let reasoning = '';
  const splitter = new ReasoningSplitter(
    (t) => (answer += t),
    (t) => (reasoning += t),
  );
  splitter.push(raw);
  splitter.flush();
  return {answer: answer.trim(), reasoning: reasoning.trim()};
}
