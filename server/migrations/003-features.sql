-- Customisation, content, community and custom roles.
CREATE TABLE custom_roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '⭐',
  permissions TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE employees
  ADD COLUMN custom_role_id TEXT REFERENCES custom_roles(id) ON DELETE SET NULL,
  ADD COLUMN birth_month INTEGER CHECK (birth_month IS NULL OR birth_month BETWEEN 1 AND 12),
  ADD COLUMN birth_day INTEGER CHECK (birth_day IS NULL OR birth_day BETWEEN 1 AND 31),
  ADD COLUMN joined_on DATE,
  ADD COLUMN avatar TEXT NOT NULL DEFAULT '',
  ADD COLUMN show_in_whosin BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE events ADD COLUMN links JSONB NOT NULL DEFAULT '[]';

CREATE TABLE links (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'General',
  emoji TEXT NOT NULL DEFAULT '🔗',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role_title TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'General',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  hours TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '📞',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE menu_items (
  id TEXT PRIMARY KEY,
  menu_date DATE NOT NULL,
  meal TEXT NOT NULL CHECK (meal IN ('breakfast', 'lunch', 'snacks', 'dinner')),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  diet TEXT NOT NULL DEFAULT 'veg' CHECK (diet IN ('veg', 'non-veg', 'vegan', 'egg')),
  emoji TEXT NOT NULL DEFAULT '🍽️',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX menu_items_date_idx ON menu_items(menu_date);

CREATE TABLE menu_reactions (
  item_id TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, employee_id)
);

CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  emoji TEXT NOT NULL DEFAULT '📣',
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ,
  created_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE kudos (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  badge TEXT NOT NULL DEFAULT 'star',
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_id <> to_id)
);
CREATE INDEX kudos_created_idx ON kudos(created_at DESC);

CREATE TABLE kudos_cheers (
  kudos_id TEXT NOT NULL REFERENCES kudos(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (kudos_id, employee_id)
);

CREATE TABLE polls (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  options JSONB NOT NULL,
  closes_at TIMESTAMPTZ,
  closed BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT REFERENCES employees(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE poll_votes (
  poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  option_index INTEGER NOT NULL,
  PRIMARY KEY (poll_id, employee_id)
);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT 'Idea',
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'seen', 'done')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO custom_roles (id, name, description, emoji, permissions) VALUES
  ('role-hr', 'HR partner', 'People, events, announcements and community moderation', '💛', ARRAY['events.manage','content.manage','community.manage','insights.view']),
  ('role-facilities', 'Facilities', 'Spaces, QR labels, bookings and the food menu', '🛠️', ARRAY['spaces.manage','qr.manage','bookings.manage','menu.manage']),
  ('role-leader', 'Leader', 'Insights dashboard and team seating', '🧭', ARRAY['insights.view','teams.manage','bookings.manage']),
  ('role-culture', 'Culture crew', 'Events, announcements and polls', '🎉', ARRAY['events.manage','content.manage','community.manage']);
