-- Additive only: the facility issue box and the notification centre. The idea box (`feedback`) is left exactly as it is.
CREATE TABLE IF NOT EXISTS issue_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🔧',
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  default_priority TEXT NOT NULL DEFAULT 'normal' CHECK (default_priority IN ('low', 'normal', 'high', 'urgent')),
  sla_hours INTEGER CHECK (sla_hours IS NULL OR sla_hours BETWEEN 1 AND 2160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who hears about a category: notify (told about new issues), escalate (told about urgent ones), assign (default assignee).
CREATE TABLE IF NOT EXISTS issue_category_routes (
  id BIGSERIAL PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES issue_categories(id) ON DELETE CASCADE,
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
  role_id TEXT REFERENCES custom_roles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('notify', 'escalate', 'assign')),
  CHECK ((employee_id IS NULL) <> (role_id IS NULL))
);
CREATE INDEX IF NOT EXISTS issue_category_routes_idx ON issue_category_routes(category_id, kind);

CREATE SEQUENCE IF NOT EXISTS issue_number_seq;
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE DEFAULT nextval('issue_number_seq'),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category_id TEXT NOT NULL REFERENCES issue_categories(id) ON DELETE RESTRICT,
  location_text TEXT NOT NULL DEFAULT '',
  resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'acknowledged', 'in_progress', 'waiting', 'resolved', 'closed')),
  reporter_id TEXT NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  assignee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
  client_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS issues_status_idx ON issues(status, created_at DESC);
CREATE INDEX IF NOT EXISTS issues_reporter_idx ON issues(reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS issues_assignee_idx ON issues(assignee_id, status) WHERE assignee_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS issues_category_idx ON issues(category_id, status);
CREATE INDEX IF NOT EXISTS issues_resource_idx ON issues(resource_id) WHERE resource_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS issues_client_key_uq ON issues(reporter_id, client_key) WHERE client_key IS NOT NULL;

-- One small photo per issue (the browser shrinks it to about 200 KB before upload).
CREATE TABLE IF NOT EXISTS issue_photos (
  issue_id TEXT PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  data BYTEA NOT NULL,
  size INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Timeline: comments, status changes, assignments, priority changes, reopen and "need help". Internal rows are staff notes.
CREATE TABLE IF NOT EXISTS issue_updates (
  id BIGSERIAL PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('comment', 'status', 'assign', 'priority', 'reopen', 'help')),
  body TEXT NOT NULL DEFAULT '',
  internal BOOLEAN NOT NULL DEFAULT FALSE,
  from_value TEXT,
  to_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS issue_updates_issue_idx ON issue_updates(issue_id, created_at);

-- "+1, me too" instead of duplicate reports.
CREATE TABLE IF NOT EXISTS issue_plusones (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (issue_id, employee_id)
);

INSERT INTO issue_categories (id, name, emoji, description, sort_order, default_priority, sla_hours) VALUES
  ('icat-cafeteria', 'Cafeteria & pantry', '☕', 'Coffee machine, water dispenser, fridge, microwave', 1, 'normal', 8),
  ('icat-washroom', 'Washroom & plumbing', '🚰', 'Taps, leaks, flush, soap and tissue refills', 2, 'normal', 4),
  ('icat-electrical', 'Electrical & lights', '💡', 'Lights, sockets, switches, power cuts', 3, 'high', 8),
  ('icat-ac', 'AC / temperature', '❄️', 'Too hot, too cold, AC noise or leaks', 4, 'normal', 8),
  ('icat-cleaning', 'Cleaning & housekeeping', '🧹', 'Spills, dustbins, dirty desks or floors', 5, 'normal', 4),
  ('icat-it', 'IT & Wi-Fi', '📶', 'Wi-Fi, displays in rooms, docking stations, printers', 6, 'normal', 8),
  ('icat-furniture', 'Furniture & desks', '🪑', 'Broken chair, wobbly desk, missing equipment', 7, 'low', 48),
  ('icat-security', 'Security & access', '🔐', 'Badge readers, doors, gates, anything that feels unsafe', 8, 'high', 2),
  ('icat-lifts', 'Lifts', '🛗', 'Lift stuck, slow or making noises', 9, 'high', 4),
  ('icat-other', 'Other', '🧩', 'Anything else that needs fixing', 10, 'normal', NULL)
ON CONFLICT DO NOTHING;

-- In-app notification centre. Kept for 30 days (the server clears old rows once a day).
CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(user_id) WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications(created_at);
