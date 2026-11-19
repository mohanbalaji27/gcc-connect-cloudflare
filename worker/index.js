import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import { createApp } from '../server/app.js';
import { prepareDatabase } from '../server/setup.js';
import { createEdgeAdapter } from './pg-edge-adapter.js';
// A Worker has no file system, so the migration files are bundled as text (see "rules" in wrangler.jsonc).
// This list is generated from server/migrations/*.sql (npm run migrations:gen) and checked by the test suite.
import { MIGRATIONS } from './migrations.generated.js';

const INTERNAL_PORT = 8787;

const connectionString = () => {
  const url = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  if (!url) throw new Error('No database configured. Bind Hyperdrive as HYPERDRIVE or set the DATABASE_URL secret.');
  return url;
};

const db = createEdgeAdapter(connectionString);
const app = createApp(db, { secureCookies: true, trustProxy: true });
app.listen(INTERNAL_PORT);
const express = httpServerHandler({ port: INTERNAL_PORT });

// Runs migrations and first-time seeding once per Worker instance; a failure is retried on the next request.
let ready;
const ensureReady = () => {
  ready ??= db.scoped(() => prepareDatabase(db, { env: process.env }, MIGRATIONS)).catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
};

export default {
  async fetch(request, workerEnv, ctx) {
    try {
      if (workerEnv.AUTO_MIGRATE !== 'false') await ensureReady();
      return await db.scoped(() => express.fetch(request, workerEnv, ctx));
    } catch (error) {
      console.error('Worker error:', error?.message);
      return Response.json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } }, { status: 500 });
    }
  },
};
