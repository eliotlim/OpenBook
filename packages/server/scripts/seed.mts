/**
 * Seed the sample document into a running OpenBook server.
 *
 *   pnpm seed                         # → http://localhost:4319
 *   pnpm seed --server http://host    # custom server
 *   OPENBOOK_SERVER_URL=… pnpm seed   # custom server via env
 *
 * Idempotent: re-running refreshes the existing "Compound Growth (sample)" page
 * rather than creating duplicates. The server must already be running
 * (`pnpm --filter @open-book/server dev`, or the desktop app's local server).
 */
import {HttpDataClient, SAMPLE_DOCUMENT_NAME, seedSampleDocument} from '@open-book/sdk';

function serverUrl(): string {
  const i = process.argv.indexOf('--server');
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.OPENBOOK_SERVER_URL ?? 'http://localhost:4319';
}

const url = serverUrl();
const client = new HttpDataClient(url);

try {
  const page = await seedSampleDocument(client);
  console.log(`Seeded "${SAMPLE_DOCUMENT_NAME}" into ${url} (page ${page.id}).`);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Seed failed against ${url}: ${message}`);
  console.error('Is the server running? Try `pnpm --filter @open-book/server dev`.');
  process.exit(1);
}
