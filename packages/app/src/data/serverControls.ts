import {invoke} from '@tauri-apps/api/tauri';
import type {ServerInfo} from '@open-book/sdk';

/**
 * Query the bundled local server managed by the Tauri host. `address` is the
 * bound `host:port`; serving on `0.0.0.0` (configurable) is what lets this
 * desktop install act as a server for other devices on the network.
 */
export const serverControls = {
  info(): Promise<ServerInfo> {
    return invoke<ServerInfo>('server_info');
  },
};
