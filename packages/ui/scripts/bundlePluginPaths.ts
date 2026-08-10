import {relative, sep} from 'node:path';

interface PathPlatform {
  relative(from: string, to: string): string;
  readonly sep: string;
}

const nativePathPlatform: PathPlatform = {relative, sep};

/**
 * Return a plugin-package key for a file on disk.
 *
 * Package keys are portable identifiers, not host filesystem paths. Always
 * use `/` so a manifest authored with `main: "src/index.ts"` resolves on
 * Windows as well as POSIX hosts.
 */
export function relativePluginPath(
  base: string,
  file: string,
  pathPlatform: PathPlatform = nativePathPlatform,
): string {
  return pathPlatform.relative(base, file).split(pathPlatform.sep).join('/');
}
