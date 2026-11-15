import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

// Workers must not keep sockets open between requests, so each request opens at most ONE connection and closes it
// afterwards. Behind Hyperdrive (or any pooler) that is cheap. Transactions run on that same connection while a
// gate holds back other queries from the same request, so they can never interleave with the transaction.
const requestScope = new AsyncLocalStorage();

export function createEdgeAdapter(getConnectionString) {
  const open = async () => {
    const client = new pg.Client({ connectionString: getConnectionString(), connectionTimeoutMillis: 8000 });
    await client.connect();
    return client;
  };
  const quietEnd = (client) => client.end().catch(() => {});
  const connection = (scope) => (scope.client ??= open());

  const adapter = {
    engine: 'postgres-edge',
    async query(sql, params) {
      const scope = requestScope.getStore();
      if (!scope) {
        const single = await open();
        try { return await single.query(sql, params); } finally { await quietEnd(single); }
      }
      while (scope.gate) await scope.gate;
      return (await connection(scope)).query(sql, params);
    },
    exec: (sql) => adapter.query(sql),
    async tx(fn) {
      const scope = requestScope.getStore();
      let release = () => {};
      let client;
      if (scope) {
        while (scope.gate) await scope.gate;
        const gate = new Promise((resolve) => { release = () => { if (scope.gate === gate) scope.gate = null; resolve(); }; });
        scope.gate = gate;
        try { client = await connection(scope); } catch (error) { release(); throw error; }
      } else {
        client = await open();
      }
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (sql, params) => client.query(sql, params), exec: (sql) => client.query(sql) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        if (scope) release(); else await quietEnd(client);
      }
    },
    close: async () => {},
    // Runs fn with a request-scoped connection and releases it afterwards.
    async scoped(fn) {
      const scope = { client: null, gate: null };
      try { return await requestScope.run(scope, fn); } finally {
        if (scope.client) scope.client.then(quietEnd, () => {});
      }
    },
  };
  return adapter;
}
