/**
 * The bridge for the "Expand" view of an interactive block's settings. Rather
 * than a bespoke drawer, the config reuses the app's existing **side pane**:
 * KitConfig portals its live fields into a host element the {@link SplitPane}
 * mounts when it shows the `CONFIG_PANE_ID` pseudo-page.
 *
 * Three module singletons, the same pattern as `kitConfig`/`openDocs`:
 *  - `panel`  — which block is being configured (id + title), or null.
 *  - `host`   — the DOM node inside the side pane to portal the fields into.
 *  - `nav`    — how to open/close that side pane, wired by NavigationProvider
 *               (the bridge stays free of React/navigation imports).
 */

export interface KitPanelState {
  blockId: string;
  title: string;
}

let panel: KitPanelState | null = null;
const panelSubs = new Set<() => void>();

let host: HTMLElement | null = null;
const hostSubs = new Set<() => void>();

let openNav: ((blockId: string) => void) | null = null;
let closeNav: (() => void) | null = null;

const fire = (subs: Set<() => void>): void => subs.forEach((cb) => cb());

/** Open (or switch) the expanded config to a block, and reveal the side pane. */
export function openKitPanel(blockId: string, title: string): void {
  panel = {blockId, title};
  fire(panelSubs);
  openNav?.(blockId);
}

/** Clear the expanded config. By default also hides the side pane; pass
 *  `keepPane` when the pane is already going away (its own unmount calls this). */
export function closeKitPanel(opts?: {keepPane?: boolean}): void {
  if (!panel) return;
  panel = null;
  fire(panelSubs);
  if (!opts?.keepPane) closeNav?.();
}

export const getKitPanel = (): KitPanelState | null => panel;

export function subscribeKitPanel(cb: () => void): () => void {
  panelSubs.add(cb);
  return () => panelSubs.delete(cb);
}

/** The side pane publishes its portal host (null on unmount). */
export function setKitPanelHost(el: HTMLElement | null): void {
  if (host === el) return;
  host = el;
  fire(hostSubs);
}

export const getKitPanelHost = (): HTMLElement | null => host;

export function subscribeKitPanelHost(cb: () => void): () => void {
  hostSubs.add(cb);
  return () => hostSubs.delete(cb);
}

/** NavigationProvider wires opening/closing the CONFIG side pane. */
export function registerKitPanelNav(open: (blockId: string) => void, close: () => void): () => void {
  openNav = open;
  closeNav = close;
  return () => {
    if (openNav === open) openNav = null;
    if (closeNav === close) closeNav = null;
  };
}
