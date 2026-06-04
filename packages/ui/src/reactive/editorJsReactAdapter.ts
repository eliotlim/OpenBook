import {createRoot, type Root} from 'react-dom/client';
import type {ReactElement} from 'react';
import type {API, BlockTool, BlockToolConstructorOptions, BlockToolData, ToolboxConfig} from '@editorjs/editorjs';

/**
 * EditorJS Tool data shape shared by all reactive blocks. Reactive state
 * (cell values) lives in the ReactiveStore — block data only carries the
 * minimum needed to re-create the block on load.
 */
export interface ReactiveBlockData extends BlockToolData {
  name?: string;
  // ExprBlock stores its source here; SliderBlock stores nothing extra.
  source?: string;
  // ChartBlock stores the cellId it targets here (NOT a name — cellIds are
  // stable across renames).
  refCellId?: string;
}

/**
 * Base class for any EditorJS Tool that wants to host React.
 *
 * EditorJS is vanilla JS — `render()` must return an HTMLElement. This
 * adapter creates that element, mounts a React root inside it, and unmounts
 * cleanly on `destroy()`. Subclasses provide `renderComponent()` (returns
 * the React element) and `toolName()` (used for the wrapper className).
 *
 * Lifecycle:
 *   render() → createElement + createRoot + render
 *   destroy() → root.unmount() (which triggers all React effect cleanups,
 *               including useReactiveCell's store.deleteCell)
 *
 * NOTE: do NOT call store.deleteCell directly from destroy(). It must come
 * from React's effect cleanup so StrictMode's mount → unmount → mount cycle
 * runs through the same code path as a real unmount.
 */
export abstract class ReactBlockTool implements BlockTool {
  protected readonly api: API;
  protected data: ReactiveBlockData;
  protected readonly cellId: string;
  protected dom: HTMLElement | null = null;
  protected root: Root | null = null;

  constructor({api, data, block}: BlockToolConstructorOptions<ReactiveBlockData>) {
    this.api = api;
    this.data = data ?? {};
    // EditorJS 2.30+ exposes block.id on the BlockAPI; this is our stable
    // cellId. The persistence layer must round-trip block.id through
    // save() and the load() data param so the same id is reassigned to the
    // same block on reload — otherwise the store's saved values are orphaned.
    this.cellId = block?.id ?? `cell-${Math.random().toString(36).slice(2)}`;
  }

  protected abstract renderComponent(): ReactElement;
  protected abstract toolName(): string;

  render(): HTMLElement {
    this.dom = document.createElement('div');
    this.dom.className = `block-${this.toolName()}`;
    this.root = createRoot(this.dom);
    this.root.render(this.renderComponent());
    return this.dom;
  }

  /**
   * EditorJS calls this on block removal. Unmounting the React root triggers
   * useEffect cleanup chains inside the component — which is where
   * useReactiveCell's store.deleteCell call lives.
   *
   * The unmount is deferred to a microtask: `editor.destroy()` is called from
   * PageDocument's effect cleanup, which can run *during* a parent re-render
   * (switching tabs or closing a split pane). Unmounting a nested React root
   * synchronously at that point makes React warn about unmounting while it is
   * already rendering. Deferring runs the unmount (and its effect cleanups)
   * just after the current render commits, which is safe.
   */
  destroy(): void {
    const root = this.root;
    this.root = null;
    this.dom = null;
    if (root) queueMicrotask(() => root.unmount());
  }

  // Subclasses override save() with their specific data shape.
  save(): ReactiveBlockData {
    return this.data;
  }

  // Default empty toolbox; subclasses override.
  static get toolbox(): ToolboxConfig {
    return {title: 'Reactive Block', icon: '⚡'};
  }
}
