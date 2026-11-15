import { createApp } from './app.js';
import { openDatabase } from './db.js';

const port = Number(process.env.PORT ?? 3000);
const production = process.env.NODE_ENV === 'production';
const host = process.env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');

const db = await openDatabase();
const app = createApp(db, { secureCookies: production, trustProxy: production });
const server = app.listen(port, host, () => {
  console.log(`GCC Connect API listening on http://${host}:${port} (database: ${db.engine})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(async () => {
    await db.close();
    process.exit(0);
  }));
}
