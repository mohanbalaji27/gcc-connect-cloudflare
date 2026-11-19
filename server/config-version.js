// A single counter that goes up whenever anything clients cache about the app changes (settings, branding, teams,
// map and floor plan, spaces). `GET /api/pulse` and the X-Config-Version header expose it, so browsers know when to reload.
export const CONFIG_VERSION_KEY = 'config_version';

export async function bumpConfigVersion(client) {
  const result = await client.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, '1'::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = to_jsonb(COALESCE((app_settings.value #>> '{}')::bigint, 0) + 1)
     RETURNING value`,
    [CONFIG_VERSION_KEY],
  );
  return Number(result.rows[0].value);
}

export async function readConfigVersion(client) {
  const row = (await client.query('SELECT value FROM app_settings WHERE key = $1', [CONFIG_VERSION_KEY])).rows[0];
  return Number(row?.value ?? 0);
}
