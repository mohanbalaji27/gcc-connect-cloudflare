-- Additive only: nothing here changes or removes existing data.

-- 1) Analytics fixes. Cancellations are now counted by WHEN they were cancelled, and poll votes by when they were cast.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
-- The exact time is known for every cancellation that went through the activity log; older bulk cancellations stay NULL
-- (reports fall back to the booking's created time for those).
UPDATE bookings b SET cancelled_at = a.at
  FROM (SELECT entity_id, MAX(created_at) AS at FROM audit_log WHERE action = 'booking.cancelled' AND entity_id IS NOT NULL GROUP BY entity_id) a
  WHERE a.entity_id = b.id AND b.status = 'cancelled' AND b.cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS bookings_cancelled_at_idx ON bookings(cancelled_at) WHERE status = 'cancelled';

ALTER TABLE poll_votes ADD COLUMN IF NOT EXISTS voted_at TIMESTAMPTZ;
UPDATE poll_votes pv SET voted_at = p.created_at FROM polls p WHERE p.id = pv.poll_id AND pv.voted_at IS NULL;
ALTER TABLE poll_votes ALTER COLUMN voted_at SET DEFAULT now();

-- 2) Usage analytics: pre-aggregated counters only (no clicks, no page content, no IP addresses).
-- One row per person, feature and office day (IST) with the number of times the screen was opened.
CREATE TABLE IF NOT EXISTS usage_daily (
  day DATE NOT NULL,
  feature TEXT NOT NULL,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (day, feature, employee_id)
);
CREATE INDEX IF NOT EXISTS usage_daily_employee_idx ON usage_daily(employee_id, day);

-- Opens per hour of the office day, with no person attached (for "peak hours").
CREATE TABLE IF NOT EXISTS usage_hourly (
  day DATE NOT NULL,
  hour SMALLINT NOT NULL CHECK (hour BETWEEN 0 AND 23),
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (day, hour)
);

-- Who signed in and when (shown as "Sign-ins" in the activity log and used for logins per day).
CREATE TABLE IF NOT EXISTS login_events (
  id BIGSERIAL PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  method TEXT NOT NULL DEFAULT 'password'
);
CREATE INDEX IF NOT EXISTS login_events_at_idx ON login_events(at DESC, id DESC);
CREATE INDEX IF NOT EXISTS login_events_employee_idx ON login_events(employee_id, at DESC);

-- 3) Activity log filters (by person, by area/action prefix, newest first with a stable cursor).
CREATE INDEX IF NOT EXISTS audit_feed_idx ON audit_log(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_log(actor_id, created_at DESC) WHERE actor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_log(action text_pattern_ops, created_at DESC);

-- 4) Important contacts on the Home page: admins pin the ones to show there.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pin_to_home BOOLEAN NOT NULL DEFAULT FALSE;
