import {existsSync, rmSync} from 'node:fs';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {startServer, type RunningServer} from './server';

/** One HTTP request over a Unix domain socket → {status, body}. */
function sock(socketPath: string, method: string, path: string, body?: unknown): Promise<{status: number; body: string}> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        method,
        path,
        headers: payload ? {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)} : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({status: res.statusCode ?? 0, body: raw}));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let server: RunningServer;
let socketPath: string;
let dataDir: string;
let seq = 0;

beforeEach(() => {
  seq += 1;
  socketPath = join(tmpdir(), `ob-sock-${process.pid}-${seq}.sock`);
  dataDir = join(tmpdir(), `ob-sock-db-${process.pid}-${seq}`);
  rmSync(socketPath, {force: true});
  rmSync(dataDir, {recursive: true, force: true});
});

afterEach(async () => {
  await server?.close();
  rmSync(socketPath, {force: true});
  rmSync(dataDir, {recursive: true, force: true});
});

describe('startServer — Unix domain socket (portless desktop IPC)', () => {
  it('serves /health and full CRUD over the socket, with no TCP port', async () => {
    server = await startServer({dataDir, socketPath});

    expect(server.url).toBe(`unix:${socketPath}`);
    expect(server.address).toBe(socketPath);

    const health = await sock(socketPath, 'GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body).toBe('ok');

    // A write and a read round-trip over the socket.
    const created = await sock(socketPath, 'POST', '/api/pages', {
      name: 'Socket Page',
      data: {editorjs: {blocks: []}, values: [], names: []},
    });
    expect(created.status).toBe(201);
    const page = JSON.parse(created.body) as {id: string; name: string};
    expect(page.name).toBe('Socket Page');

    const list = await sock(socketPath, 'GET', '/api/pages');
    expect(list.status).toBe(200);
    expect((JSON.parse(list.body) as {id: string}[]).map((p) => p.id)).toContain(page.id);

    // Portless: no TCP discovery file is written (there is no address to find).
    expect(existsSync(join(dataDir, 'server.json'))).toBe(false);
  });

  it('can serve a socket and a TCP port at once (the publish case)', async () => {
    server = await startServer({dataDir, socketPath, host: '127.0.0.1', port: 0});

    // The TCP URL is the primary url; the socket still answers.
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const viaSocket = await sock(socketPath, 'GET', '/health');
    expect(viaSocket.status).toBe(200);

    const viaTcp = await fetch(`${server.url}/health`);
    expect(viaTcp.ok).toBe(true);
    // Now there *is* a TCP address, so discovery is written.
    expect(existsSync(join(dataDir, 'server.json'))).toBe(true);
  });
});
