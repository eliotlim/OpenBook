import {spawn} from 'node:child_process';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, {recursive: true, force: true})));
});

describe('scheduled backup memory bound (BOOT-2)', () => {
  it('writes a 128 MiB synthetic asset corpus under a 48 MiB V8 heap cap', async () => {
    const outputDir = join(tmpdir(), `ob-backup-memory-${process.pid}-${Date.now()}`);
    dirs.push(outputDir);
    const fixture = fileURLToPath(new URL('./backupMemory.fixture.mjs', import.meta.url));
    const child = spawn(process.execPath, ['--max-old-space-size=48', '--import', 'tsx', fixture, outputDir], {
      cwd: process.cwd(),
      env: {...process.env, NODE_OPTIONS: ''},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));

    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });

    expect(code, stderr).toBe(0);
    const result = JSON.parse(stdout) as {rawBytes: number; fileBytes: number};
    expect(result.rawBytes).toBe(128 * 1024 * 1024);
    expect(result.fileBytes).toBeGreaterThan(result.rawBytes);
  }, 60_000);
});
