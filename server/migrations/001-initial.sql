-- PostgreSQL schema. Runs unchanged on local PGlite and on Railway PostgreSQL.
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  team TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('user', 'admin', 'super_admin')),
  permissions TEXT[] NOT NULL DEFAULT '{}',
  password_hash TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('desk', 'room')),
  label TEXT NOT NULL,
  building TEXT NOT NULL,
  floor TEXT NOT NULL,
  zone TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  amenities JSONB NOT NULL DEFAULT '[]',
  capacity INTEGER,
  team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
  grid_row INTEGER,
  grid_col INTEGER,
  x_pct DOUBLE PRECISION CHECK (x_pct IS NULL OR (x_pct >= 0 AND x_pct <= 100)),
  y_pct DOUBLE PRECISION CHECK (y_pct IS NULL OR (y_pct >= 0 AND y_pct <= 100)),
  placed_manually BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX resources_team_idx ON resources(team_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE INDEX sessions_employee_idx ON sessions(employee_id);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at)
);
CREATE INDEX bookings_resource_time_idx ON bookings(resource_id, starts_at, ends_at, status);
CREATE INDEX bookings_owner_time_idx ON bookings(employee_id, starts_at, status);

CREATE TABLE idempotency (
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, key)
);

CREATE TABLE booking_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  eligible_employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ,
  max_redemptions INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  redemption_count INTEGER NOT NULL DEFAULT 0 CHECK (redemption_count >= 0),
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE token_redemptions (
  token_id TEXT NOT NULL REFERENCES booking_tokens(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (token_id, employee_id, booking_id)
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  venue TEXT NOT NULL,
  category TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'All employees',
  created_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at)
);
CREATE INDEX events_start_idx ON events(starts_at);

CREATE TABLE event_rsvps (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, employee_id)
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_id TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_log(created_at DESC);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);
