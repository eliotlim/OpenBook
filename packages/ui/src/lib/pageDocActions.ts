/**
 * Bridge between the open page documents and the shell: a document registers
 * its export/delete capabilities here (keyed by page id), and the nav-bar
 * page menu renders whatever the *current* page can do. A module singleton,
 * like the plugin command registry — the shell and the documents never hold
 * references to each other.
 */

export type ExportKind =
  | 'md'
  | 'pdf-paged'
  | 'pdf-continuous'
  | 'pdf-slides'
  | 'html'
  | 'html-slides'
  | 'plugin';

export interface PageDocActions {
  /** Which export formats this document offers (order = menu order). */
  exportKinds: ExportKind[];
  runExport: (kind: ExportKind) => void | Promise<void>;
  /** Move the page to the trash (confirms per user preference). */
  deletePage?: () => void | Promise<void>;
}

const registry = new Map<string, PageDocActions>();
const subscribers = new Set<() => void>();
let version = 0;

const notify = (): void => {
  version += 1;
  subscribers.forEach((cb) => cb());
};

export function registerPageDocActions(pageId: string, actions: PageDocActions): () => void {
  registry.set(pageId, actions);
  notify();
  return () => {
    if (registry.get(pageId) === actions) {
      registry.delete(pageId);
      notify();
    }
  };
}

export const pageDocActions = (pageId: string | null | undefined): PageDocActions | undefined =>
  pageId ? registry.get(pageId) : undefined;

export const subscribePageDocActions = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};

/** Monotonic change counter — pair with useSyncExternalStore. */
export const pageDocActionsVersion = (): number => version;
