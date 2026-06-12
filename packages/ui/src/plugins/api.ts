import React from 'react';
import type {DataClient, PageMeta, StoredPage} from '@open-book/sdk';
import {registerCustomBlock, type CustomBlockDef} from '../blockeditor/registry';
import {registerPluginCommand, type PluginCommand} from './commandRegistry';

/**
 * The API handed to a plugin's `activate(api)` — the whole contract between
 * a plugin and the app. Everything registered through it is tracked, so
 * disabling or removing the plugin tears its contributions down cleanly.
 *
 * Plugins import this module as `@open-book/plugin-sdk` (and React as
 * `react`); both resolve to host instances, never bundled copies.
 */

export interface PluginBlockDef {
  /** Block type, namespaced automatically as `<pluginId>/<type>`. */
  type: string;
  render: CustomBlockDef['render'];
  slash?: CustomBlockDef['slash'];
}

export interface PluginCommandDef {
  id: string;
  title: string;
  keywords?: string;
  run: () => void;
}

export interface PluginApi {
  /** The plugin's own manifest (id, name, version…). */
  manifest: {id: string; name: string; version: string};
  /** Register a custom block (renders in documents; optional slash entry). */
  blocks: {register(def: PluginBlockDef): void};
  /** Register a command-palette command. */
  commands: {register(def: PluginCommandDef): void};
  /** Read and write workspace pages (integration surface). */
  pages: {
    list(): Promise<PageMeta[]>;
    get(id: string): Promise<StoredPage | null>;
    create(name: string, markdownish?: string): Promise<StoredPage>;
  };
  /** Plugin-scoped persistent key-value storage (per browser profile). */
  storage: {get<T = unknown>(key: string): T | undefined; set(key: string, value: unknown): void};
  /** Network access for integrations (plain fetch — same trust as live code). */
  fetch: typeof fetch;
}

/** What `activate` may hand back (everything optional). */
export interface PluginActivationResult {
  deactivate?: () => void;
}

export type PluginModule = {
  default?: (api: PluginApi) => PluginActivationResult | void;
  activate?: (api: PluginApi) => PluginActivationResult | void;
};

/** Build a plugin's API instance; `disposables` collects every teardown. */
export function buildPluginApi(
  manifest: {id: string; name: string; version: string},
  client: DataClient,
  disposables: Array<() => void>,
): PluginApi {
  const storagePrefix = `openbook.plugin.${manifest.id}.`;
  return {
    manifest: {id: manifest.id, name: manifest.name, version: manifest.version},
    blocks: {
      register(def: PluginBlockDef): void {
        disposables.push(
          registerCustomBlock({
            type: `${manifest.id}/${def.type}`,
            render: def.render,
            slash: def.slash,
          }),
        );
      },
    },
    commands: {
      register(def: PluginCommandDef): void {
        const command: PluginCommand = {
          id: `${manifest.id}/${def.id}`,
          title: def.title,
          keywords: def.keywords ?? '',
          run: def.run,
          pluginId: manifest.id,
        };
        disposables.push(registerPluginCommand(command));
      },
    },
    pages: {
      list: () => client.listPages(),
      get: (id) => client.getPage(id),
      create: (name, text) =>
        client.savePage({
          name,
          data: {
            editorjs: {
              blocks: (text ?? '')
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean)
                .map((t, i) => ({id: `pl-${i}`, type: 'paragraph', data: {text: t}})),
            },
            values: [],
            names: [],
          },
        }),
    },
    storage: {
      get<T>(key: string): T | undefined {
        try {
          const raw = localStorage.getItem(storagePrefix + key);
          return raw === null ? undefined : (JSON.parse(raw) as T);
        } catch {
          return undefined;
        }
      },
      set(key: string, value: unknown): void {
        try {
          localStorage.setItem(storagePrefix + key, JSON.stringify(value));
        } catch {
          // quota/private mode — plugin storage is best-effort
        }
      },
    },
    fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  };
}

/** Host modules importable from plugin code. */
export const hostModulesFor = (api: PluginApi): Record<string, unknown> => ({
  react: React,
  '@open-book/plugin-sdk': {api},
});
