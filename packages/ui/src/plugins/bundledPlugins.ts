import type {PluginPackage} from '@book.dev/sdk';
import {BUNDLED_PLUGINS} from './bundled.gen';

export interface BundledPluginInfo {
  id: string;
  name: string;
  description: string;
  icon?: string;
  package: PluginPackage;
}

const bundledPlugins: Record<string, BundledPluginInfo> = {};
for (const pkg of BUNDLED_PLUGINS) {
  bundledPlugins[pkg.manifest.id] = {
    id: pkg.manifest.id,
    name: pkg.manifest.name,
    description: pkg.manifest.description ?? '',
    icon: pkg.manifest.icon,
    package: pkg,
  };
}

export function getBundledPlugin(id: string): BundledPluginInfo | undefined {
  return bundledPlugins[id];
}
