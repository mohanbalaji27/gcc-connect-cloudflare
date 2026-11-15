// Local PostgreSQL for `npm run cf:dev`: PGlite exposed over a socket, persisted in ./data/cf-dev-pg.
// Wrangler's Hyperdrive "localConnectionString" points at it (see wrangler.jsonc).
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { mkdirSync } from 'node:fs';

const port = Number(process.env.CF_DEV_DB_PORT ?? 5544);
const dir = process.env.CF_DEV_DB_DIR ?? './data/cf-dev-pg';
mkdirSync(dir, { recursive: true });
const db = await PGlite.create(dir);
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
await server.start();
console.log(`Local PostgreSQL ready on postgres://postgres:postgres@127.0.0.1:${port}/postgres`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await server.stop();
    await db.close();
    process.exit(0);
  });
}

