/**
 * The desktop implementation of `PlatformLibrary.updates` (OB-342): version
 * surface + update check + download/relaunch, wrapping the Tauri v2 updater.
 *
 * Config-vs-JS asymmetry (intentional, security-relevant): there are TWO
 * endpoints in play and they resolve differently.
 *  - `checkForUpdate()` (here, JS) calls the account *check* route — purely
 *    informational ("is there something newer / a security fix?"). It honors
 *    the `resolveAccountUrl()` localStorage override (`openbook.accountUrl`),
 *    so dev / self-host setups can point the check at their own account
 *    service.
 *  - `downloadAndInstall()` goes through the Rust updater plugin, whose
 *    *manifest* endpoint and minisign pubkey are pinned in `tauri.conf.json`
 *    and compiled into the binary. That pair is the supply-chain trust anchor:
 *    no localStorage value can redirect where installs come from or what key
 *    they must verify against.
 */

import {getVersion} from '@tauri-apps/api/app';
import {invoke} from '@tauri-apps/api/core';
import {check} from '@tauri-apps/plugin-updater';
import {relaunch} from '@tauri-apps/plugin-process';
import {checkForUpdateViaAccount, type UpdateCheckResult, type UpdatesPlatform} from '@book.dev/ui';

/** What the Rust `update_target` command reports: the compile-time build
 *  target in the check API's vocabulary (`darwin`/`linux`/`windows` +
 *  `aarch64`/`x86_64`). Compile-time, so an Intel build under Rosetta keeps
 *  asking for (and receiving) x86_64 updates. */
interface UpdateTarget {
  target: string;
  arch: string;
}

export function createDesktopUpdates(): UpdatesPlatform {
  return {
    getAppVersion: () => getVersion(),

    // Never rejects: any failure to assemble params or reach the account
    // service resolves as {status: 'error'} (see UpdateCheckResult).
    checkForUpdate: async (): Promise<UpdateCheckResult> => {
      try {
        const [version, build] = await Promise.all([getVersion(), invoke<UpdateTarget>('update_target')]);
        return await checkForUpdateViaAccount({version, target: build.target, arch: build.arch});
      } catch (e) {
        return {status: 'error', error: e instanceof Error ? e.message : String(e)};
      }
    },

    // Stage the newest same-major update via the pinned manifest + pubkey. The
    // plugin's check() returns null when the manifest says we're current (its
    // 204 path) — that's a successful no-op, not an error. Download/signature
    // failures reject, per the contract; callers own that error surface.
    downloadAndInstall: async (): Promise<void> => {
      const update = await check();
      if (!update) return;
      await update.downloadAndInstall();
    },

    // Apply a staged update by relaunching (tauri-plugin-process).
    relaunch: () => relaunch(),
  };
}
