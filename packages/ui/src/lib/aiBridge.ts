/**
 * Bridge between the (provider-less) block editor and the app's AI client —
 * the same singleton pattern as `pageLinks`. The app installs it once
 * (DefaultLayout); editor slash items consult `ready` to decide whether to
 * appear and call through for completions / task breakdowns.
 */

export interface AiBridgeImpl {
  /** Engine is configured and was ready at the last status poll. */
  ready: () => boolean;
  complete: (text: string, onToken: (token: string) => void) => Promise<string>;
  tasks: (goal: string, context?: string) => Promise<string[]>;
}

let bridge: AiBridgeImpl | null = null;
const subscribers = new Set<() => void>();

export const setAiBridge = (next: AiBridgeImpl | null): void => {
  bridge = next;
  subscribers.forEach((cb) => cb());
};

export const subscribeAiBridge = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};

export const aiBridge = {
  ready: (): boolean => bridge?.ready() ?? false,
  complete: (text: string, onToken: (token: string) => void): Promise<string> =>
    bridge ? bridge.complete(text, onToken) : Promise.reject(new Error('AI not available')),
  tasks: (goal: string, context?: string): Promise<string[]> =>
    bridge ? bridge.tasks(goal, context) : Promise.reject(new Error('AI not available')),
};
