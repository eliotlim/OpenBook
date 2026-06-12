/**
 * Palette commands contributed by plugins. Same module-singleton pattern as
 * the custom-block registry: registration works from any layer, and the
 * palette re-reads on every change via subscription.
 */

export interface PluginCommand {
  id: string;
  title: string;
  keywords: string;
  run: () => void;
  pluginId: string;
}

const commands = new Map<string, PluginCommand>();
const subscribers = new Set<() => void>();

export function registerPluginCommand(command: PluginCommand): () => void {
  commands.set(command.id, command);
  subscribers.forEach((cb) => cb());
  return () => {
    if (commands.get(command.id) === command) {
      commands.delete(command.id);
      subscribers.forEach((cb) => cb());
    }
  };
}

export const pluginCommands = (): PluginCommand[] => [...commands.values()];

export const subscribePluginCommands = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
};
