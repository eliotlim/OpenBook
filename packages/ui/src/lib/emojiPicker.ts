/**
 * A tiny singleton bridge to the one app-wide emoji grid picker. Any call site —
 * React component or **vanilla** EditorJS block tool (which has no provider tree,
 * cf. `lib/pageLinks.ts`) — opens the picker anchored at a screen rect and gets a
 * callback when an emoji is chosen. The `<EmojiPickerHost>` mounted at the app
 * shell renders the actual picker over this state.
 */
export interface EmojiPickerAnchor {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface EmojiPickerState {
  open: boolean;
  anchor: EmojiPickerAnchor | null;
  value: string;
  onPick: ((emoji: string) => void) | null;
}

const CLOSED: EmojiPickerState = {open: false, anchor: null, value: '', onPick: null};

class EmojiPickerBridge {
  private state: EmojiPickerState = CLOSED;
  private readonly listeners = new Set<() => void>();

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getState = (): EmojiPickerState => this.state;

  private set(next: EmojiPickerState): void {
    this.state = next;
    this.listeners.forEach((cb) => cb());
  }

  /** Open the picker anchored at `anchor` (a DOMRect-like), reporting picks to `onPick`. */
  open = (anchor: EmojiPickerAnchor, value: string, onPick: (emoji: string) => void): void => {
    this.set({open: true, anchor, value, onPick});
  };

  close = (): void => {
    if (this.state.open) this.set(CLOSED);
  };
}

export const emojiPicker = new EmojiPickerBridge();
