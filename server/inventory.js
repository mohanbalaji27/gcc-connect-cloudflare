import { gridPlacement, DEFAULT_CALIBRATION, validCalibration } from './layout.js';

export const TEAM_COLORS = ['#2f9e6f', '#e8772e', '#6c5ce7', '#0984e3', '#d63384', '#c9a100', '#00a8a8', '#8d5524', '#e03131', '#5b8c00', '#1c3d8f', '#7a869a'];
const MAX_SEATS = 500;

const fail = (message) => Object.assign(new Error(message), { status: 400, code: 'INVALID_INVENTORY' });
const intOrNull = (value, max) => (value === null || value === undefined ? null : Number.isInteger(value) && value >= 1 && value <= max ? value : undefined);
const percentOrNull = (value) => (value === null || value === undefined ? null : typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined);

export function validateInventory(inventory) {
  if (!inventory || !Array.isArray(inventory.seats) || !inventory.seats.length || inventory.seats.length > MAX_SEATS) {
    throw fail(`Provide between 1 and ${MAX_SEATS} seats.`);
  }
  const labels = new Set();
  return inventory.seats.map((seat) => {
    const label = typeof seat?.label === 'string' ? seat.label.trim() : '';
    const team = typeof seat?.team === 'string' ? seat.team.trim() : '';
    const row = intOrNull(seat?.row, 1000);
    const column = intOrNull(seat?.column, 200);
    const x = percentOrNull(seat?.x);
    const y = percentOrNull(seat?.y);
    if (!/^[A-Za-z0-9][A-Za-z0-9 -]{0,39}$/.test(label)) throw fail(`“${String(seat?.label).slice(0, 40)}” is not a valid seat label.`);
    if (team.length > 100) throw fail(`Team name for ${label} is too long.`);
    if (row === undefined || column === undefined || x === undefined || y === undefined) throw fail(`Seat ${label} has an invalid row, column or position.`);
    if (labels.has(label.toLowerCase())) throw fail(`Seat ${label} appears more than once.`);
    labels.add(label.toLowerCase());
    return { label, team: team === 'Unassigned' ? '' : team, row, column, x, y };
  });
}

// Adds or updates desks (and their teams) inside an open transaction. With `replace`, desks that are not in
// the list are retired and their upcoming bookings cancelled.
export async function importInventory(tx, inventory, { replace = false } = {}) {
  const seats = validateInventory(inventory);
  const calibrationRow = (await tx.query("SELECT value FROM app_settings WHERE key = 'calibration'")).rows[0];
  const calibration = validCalibration(calibrationRow?.value) ? calibrationRow.value : DEFAULT_CALIBRATION;
  if (!calibrationRow) await tx.query("INSERT INTO app_settings (key, value) VALUES ('calibration', $1)", [JSON.stringify(calibration)]);

  const teamRows = (await tx.query('SELECT id, name FROM teams')).rows;
  const teamIds = new Map(teamRows.map((team) => [team.name.toLowerCase(), team.id]));
  let teamsCreated = 0;
  let order = (await tx.query('SELECT COALESCE(MAX(sort_order), -1)::int AS max FROM teams')).rows[0].max + 1;
  for (const name of [...new Set(seats.map((seat) => seat.team).filter(Boolean))]) {
    if (teamIds.has(name.toLowerCase())) continue;
    const id = `team-${teamIds.size + 1}-${Math.random().toString(36).slice(2, 6)}`;
    await tx.query('INSERT INTO teams (id, name, color, sort_order) VALUES ($1,$2,$3,$4)', [id, name, TEAM_COLORS[(teamRows.length + teamsCreated) % TEAM_COLORS.length], order]);
    teamIds.set(name.toLowerCase(), id);
    teamsCreated += 1;
    order += 1;
  }

  const placement = gridPlacement(seats.map((seat) => ({ id: seat.label, row: seat.row, col: seat.column })), calibration);
  const existing = new Map((await tx.query("SELECT id, label FROM resources WHERE type = 'desk'")).rows.map((row) => [row.label.toLowerCase(), row.id]));
  let created = 0;
  let updated = 0;
  for (const seat of seats) {
    const point = seat.x !== null && seat.y !== null ? { x: seat.x, y: seat.y } : placement.get(seat.label) ?? { x: null, y: null };
    const teamId = seat.team ? teamIds.get(seat.team.toLowerCase()) : null;
    const id = existing.get(seat.label.toLowerCase());
    if (id) {
      await tx.query(
        `UPDATE resources SET active = TRUE, zone = $2, team_id = $3, grid_row = $4, grid_col = $5,
           x_pct = COALESCE($6, x_pct), y_pct = COALESCE($7, y_pct) WHERE id = $1`,
        [id, seat.team, teamId ?? null, seat.row, seat.column, point.x, point.y],
      );
      updated += 1;
    } else {
      const newId = `seat-${seat.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      await tx.query(
        `INSERT INTO resources (id, type, label, building, floor, zone, description, amenities, team_id, grid_row, grid_col, x_pct, y_pct)
         VALUES ($1,'desk',$2,'GCC Office','Main floor',$3,'Workstation with a monitor and docking support.', $4, $5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET active = TRUE, label = excluded.label, zone = excluded.zone, team_id = excluded.team_id,
           grid_row = excluded.grid_row, grid_col = excluded.grid_col, x_pct = COALESCE(excluded.x_pct, resources.x_pct), y_pct = COALESCE(excluded.y_pct, resources.y_pct)`,
        [newId, seat.label, seat.team, JSON.stringify(['Monitor', 'Dock']), teamId ?? null, seat.row, seat.column, point.x, point.y],
      );
      created += 1;
    }
  }

  let retired = 0;
  if (replace) {
    const keep = seats.map((seat) => seat.label.toLowerCase());
    const stale = (await tx.query("SELECT id FROM resources WHERE type = 'desk' AND active = TRUE AND NOT (lower(label) = ANY($1::text[]))", [keep])).rows.map((row) => row.id);
    if (stale.length) {
      await tx.query("UPDATE bookings SET status = 'cancelled' WHERE resource_id = ANY($1::text[]) AND status = 'confirmed' AND ends_at > now()", [stale]);
      await tx.query('UPDATE resources SET active = FALSE WHERE id = ANY($1::text[])', [stale]);
      retired = stale.length;
    }
  }
  let roomsImported = 0;
  for (const room of Array.isArray(inventory.rooms) ? inventory.rooms.slice(0, 100) : []) {
    const label = typeof room?.label === 'string' ? room.label.trim() : '';
    const x = percentOrNull(room?.x);
    const y = percentOrNull(room?.y);
    const capacity = Number.isInteger(room?.capacity) && room.capacity >= 1 && room.capacity <= 500 ? room.capacity : null;
    if (!label || label.length > 40 || x === undefined || y === undefined) throw fail('A room in the file has an invalid name or position.');
    const found = (await tx.query("SELECT id FROM resources WHERE type = 'room' AND lower(label) = lower($1)", [label])).rows[0];
    if (found) {
      await tx.query('UPDATE resources SET active = TRUE, x_pct = COALESCE($2, x_pct), y_pct = COALESCE($3, y_pct), capacity = COALESCE($4, capacity) WHERE id = $1', [found.id, x, y, capacity]);
    } else {
      await tx.query(
        `INSERT INTO resources (id, type, label, building, floor, zone, description, amenities, capacity, x_pct, y_pct, placed_manually)
         VALUES ($1,'room',$2,'GCC Office','Main floor','Rooms','', '[]', $3, $4, $5, TRUE)`,
        [`room-${Math.random().toString(36).slice(2, 10)}`, label, capacity ?? 6, x ?? 50, y ?? 50],
      );
    }
    roomsImported += 1;
  }
  return { created, updated, retired, teamsCreated, roomsImported };
}
