import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { prepareDatabase } from './setup.js';

async function createAdapter(options) {
  const url = options.url ?? process.env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import('pg');
    const ssl = options.ssl ?? process.env.DATABASE_SSL;
    const pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      // DATABASE_SSL=true verifies the server certificate; "no-verify" encrypts without verifying (use only if you must).
      ssl: ssl === 'true' ? { rejectUnauthorized: true } : ssl === 'no-verify' ? { rejectUnauthorized: false } : undefined,
    });
    return {
      engine: 'postgres',
      query: (sql, params) => pool.query(sql, params),
      exec: (sql) => pool.query(sql),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn({ query: (sql, params) => client.query(sql, params), exec: (sql) => client.query(sql) });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  let location;
  if (options.memory) location = 'memory://';
  else {
    location = resolve(options.dataDir ?? process.env.PGLITE_DIR ?? './data/pglite');
    mkdirSync(location, { recursive: true });
  }
  const lite = new PGlite(location);
  await lite.waitReady;
  return {
    engine: 'pglite',
    query: (sql, params) => lite.query(sql, params),
    exec: (sql) => lite.exec(sql),
    tx: (fn) => lite.transaction((client) => fn({ query: (sql, params) => client.query(sql, params), exec: (sql) => client.exec(sql) })),
    close: () => lite.close(),
  };
}

export async function openDatabase(input = {}) {
  const db = await createAdapter(input);
  return prepareDatabase(db, input);
}
