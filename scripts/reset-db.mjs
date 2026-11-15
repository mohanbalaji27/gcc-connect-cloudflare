import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

const target = resolve(process.env.PGLITE_DIR ?? './data/pglite');
if (process.env.DATABASE_URL) {
  console.error('DATABASE_URL is set; refusing to touch a remote database. Unset it to reset the local one.');
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
console.log(`Removed ${target}. The next server start recreates and reseeds the database.`);
