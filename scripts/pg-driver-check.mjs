// Runs the API test-suite through the real `pg` driver (the one used on Railway) by exposing an
// in-memory PostgreSQL over a local socket. Usage: npm run test:pg
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { spawn } from 'node:child_process';

const db = await PGlite.create();
const server = new PGLiteSocketServer({ db, port: 54329, host: '127.0.0.1' });
await server.start();

const child = spawn(process.execPath, ['--test', '--test-concurrency=1'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:54329/postgres', DATABASE_POOL_MAX: '1' },
});
child.on('exit', async (code) => {
  await server.stop();
  await db.close();
  process.exit(code ?? 1);
});
