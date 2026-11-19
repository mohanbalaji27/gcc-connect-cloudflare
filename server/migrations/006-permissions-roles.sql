-- Additive only: nothing here removes data or access.
-- 1) Optional username (employee ID) sign-in for people without a corporate email, and per-person notification choices.
ALTER TABLE employees ALTER COLUMN email DROP NOT NULL;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS notify_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS employees_username_uq ON employees (lower(username)) WHERE username IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_login_check') THEN
    ALTER TABLE employees ADD CONSTRAINT employees_login_check CHECK (email IS NOT NULL OR username IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employees_username_format') THEN
    ALTER TABLE employees ADD CONSTRAINT employees_username_format CHECK (username IS NULL OR username ~ '^[A-Za-z0-9._-]{3,32}$');
  END IF;
END $$;

-- 2) Roles carry more than permissions: default notifications and the experience people land in.
ALTER TABLE custom_roles ADD COLUMN IF NOT EXISTS system_key TEXT;
ALTER TABLE custom_roles ADD COLUMN IF NOT EXISTS simple_ui BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE custom_roles ADD COLUMN IF NOT EXISTS landing TEXT NOT NULL DEFAULT '';
ALTER TABLE custom_roles ADD COLUMN IF NOT EXISTS notify_defaults JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS custom_roles_system_key_uq ON custom_roles (system_key) WHERE system_key IS NOT NULL;

-- 3) Finer permissions. The old strings stay on every person and role; the finer ones that they used to cover are added
-- next to them, so nobody loses anything (the server also expands the old strings when it reads them).
UPDATE employees SET permissions = ARRAY(SELECT DISTINCT p FROM unnest(
    permissions
    || CASE WHEN 'bookings.manage' = ANY(permissions) THEN ARRAY['bookings.view_all', 'bookings.cancel_others'] ELSE ARRAY[]::text[] END
    || CASE WHEN 'events.manage' = ANY(permissions) THEN ARRAY['events.create', 'events.edit', 'events.delete'] ELSE ARRAY[]::text[] END
    || CASE WHEN 'content.manage' = ANY(permissions) THEN ARRAY['content.links', 'content.contacts', 'content.announcements'] ELSE ARRAY[]::text[] END
    || CASE WHEN 'menu.manage' = ANY(permissions) THEN ARRAY['menu.edit', 'menu.reviews.view'] ELSE ARRAY[]::text[] END
    || CASE WHEN 'community.manage' = ANY(permissions) THEN ARRAY['community.polls', 'community.ideas', 'community.moderation'] ELSE ARRAY[]::text[] END
    || CASE WHEN 'users.manage' = ANY(permissions) THEN ARRAY['users.view', 'users.create', 'users.edit', 'users.reset_password', 'users.change_roles', 'users.audit'] ELSE ARRAY[]::text[] END
  ) AS p)
WHERE permissions && ARRAY['bookings.manage', 'events.manage', 'content.manage', 'menu.manage', 'community.manage', 'users.manage'];

UPDATE custom_roles SET permissions = ARRAY(SELECT DISTINCT p FROM unnest(
    permissions
    || CASE WHEN 'bookings.manage' = ANY(permissions) THEN ARRAY['bookings.view_all', 'bookings.cancel_others'] ELSE ARRAY[]::text[] END
    || CASE WHEN 'events.manage' = ANY(permissions) THEN ARRAY['events.create', 'events.edit', 'events.delete'] ELSE ARRAY[]::text[] END
    || CASE WHEN 'content.manage' = ANY(permissions) THEN ARRAY['content.links', 'content.contacts', 'content.announcements'] ELSE ARRAY[]::text[] END
    || CASE WHEN 'menu.manage' = ANY(permissions) THEN ARRAY['menu.edit', 'menu.reviews.view'] ELSE ARRAY[]::text[] END
    || CASE WHEN 'community.manage' = ANY(permissions) THEN ARRAY['community.polls', 'community.ideas', 'community.moderation'] ELSE ARRAY[]::text[] END
    || CASE WHEN 'users.manage' = ANY(permissions) THEN ARRAY['users.view', 'users.create', 'users.edit', 'users.reset_password', 'users.change_roles', 'users.audit'] ELSE ARRAY[]::text[] END
  ) AS p)
WHERE permissions && ARRAY['bookings.manage', 'events.manage', 'content.manage', 'menu.manage', 'community.manage', 'users.manage'];

-- Existing admins already ran the whole office; they also get the new facility issue tools.
UPDATE employees SET permissions = ARRAY(SELECT DISTINCT p FROM unnest(
    permissions || ARRAY['issues.view_all', 'issues.assign', 'issues.update', 'issues.manage_categories', 'issues.export', 'notifications.route']
  ) AS p)
WHERE role = 'admin';

-- 4) Kudos becomes optional and off for NEW installs only. Installs that exist today keep exactly what they have now.
UPDATE app_settings SET value = '{"kudos": true}'::jsonb || value WHERE key = 'features';
INSERT INTO app_settings (key, value)
  SELECT 'features', '{"kudos": true}'::jsonb
  WHERE EXISTS (SELECT 1 FROM employees) AND NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'features');

-- 5) Starting-point roles (editable; the ones with a system key cannot be deleted).
INSERT INTO custom_roles (id, name, description, emoji, permissions, system_key, simple_ui, landing, notify_defaults) VALUES
  ('role-employee', 'Employee', 'Everyone. Can book, report problems and follow their own reports.', '🙂', ARRAY[]::text[], 'employee', FALSE, '',
    '{"types":{"issue_update":{"inapp":true},"announcement":{"inapp":true}}}'::jsonb),
  ('role-facility-staff', 'Facility staff', 'Hands-on team. Simple big-button home with their tasks and the issue queue.', '🧰',
    ARRAY['issues.view_all', 'issues.update'], 'facility_staff', TRUE, 'tasks',
    '{"types":{"issue_new":{"inapp":true},"issue_assigned":{"inapp":true},"issue_update":{"inapp":true},"issue_urgent":{"inapp":true},"announcement":{"inapp":true}}}'::jsonb),
  ('role-facility-manager', 'Facility manager', 'Runs the issue queue: assigns, escalates, edits categories and routing.', '🛠️',
    ARRAY['issues.view_all', 'issues.assign', 'issues.update', 'issues.manage_categories', 'issues.export', 'notifications.route', 'bookings.view_all', 'bookings.cancel_others', 'spaces.manage', 'qr.manage'], 'facility_manager', FALSE, '',
    '{"types":{"issue_new":{"inapp":true},"issue_assigned":{"inapp":true},"issue_update":{"inapp":true},"issue_urgent":{"inapp":true},"announcement":{"inapp":true}}}'::jsonb),
  ('role-food-manager', 'Cafeteria / food manager', 'Runs the food menu and the cafeteria issue category.', '🍽️',
    ARRAY['menu.edit', 'menu.reviews.view', 'issues.view_all', 'issues.update', 'content.announcements'], 'food_manager', FALSE, '',
    '{"types":{"issue_new":{"inapp":true},"issue_assigned":{"inapp":true},"issue_update":{"inapp":true},"announcement":{"inapp":true}},"categories":["icat-cafeteria"]}'::jsonb),
  ('role-hr-people', 'HR / People team', 'Events, announcements, polls, the idea box and insights.', '💛',
    ARRAY['events.create', 'events.edit', 'events.delete', 'content.announcements', 'content.links', 'content.contacts', 'community.polls', 'community.ideas', 'community.moderation', 'insights.view'], 'hr_people', FALSE, '',
    '{"types":{"idea_new":{"inapp":true},"issue_update":{"inapp":true},"announcement":{"inapp":true}}}'::jsonb),
  ('role-reception', 'Receptionist / front desk', 'Sees all bookings and issues, cancels bookings and hands issues to the right person.', '🛎️',
    ARRAY['bookings.view_all', 'bookings.cancel_others', 'issues.view_all', 'issues.assign', 'qr.manage'], 'reception', FALSE, '',
    '{"types":{"issue_new":{"inapp":true},"issue_urgent":{"inapp":true},"issue_update":{"inapp":true},"announcement":{"inapp":true}}}'::jsonb),
  ('role-floor-warden', 'Floor warden', 'Looks after safety on a floor: sees every issue and is told about urgent ones.', '🦺',
    ARRAY['issues.view_all', 'issues.update', 'bookings.view_all'], 'floor_warden', FALSE, '',
    '{"types":{"issue_urgent":{"inapp":true},"issue_update":{"inapp":true},"announcement":{"inapp":true}},"categories":["icat-security","icat-lifts","icat-electrical"]}'::jsonb),
  ('role-admin', 'Admin', 'Runs the office app day to day. Everything except managing people and roles.', '🧑‍💼',
    ARRAY['bookings.view_all', 'bookings.cancel_others', 'events.create', 'events.edit', 'events.delete', 'spaces.manage', 'teams.manage', 'qr.manage', 'content.links', 'content.contacts', 'content.announcements', 'menu.edit', 'menu.reviews.view', 'community.polls', 'community.ideas', 'community.moderation', 'issues.view_all', 'issues.assign', 'issues.update', 'issues.manage_categories', 'issues.export', 'notifications.route', 'insights.view'], 'admin', FALSE, '',
    '{"types":{"issue_new":{"inapp":true},"issue_urgent":{"inapp":true},"issue_update":{"inapp":true},"announcement":{"inapp":true}}}'::jsonb),
  ('role-super-admin', 'Super admin', 'Full control. Shown for reference: choose “Super admin” in a person’s Role to give it.', '👑',
    ARRAY['bookings.view_all', 'bookings.cancel_others', 'events.create', 'events.edit', 'events.delete', 'spaces.manage', 'teams.manage', 'qr.manage', 'content.links', 'content.contacts', 'content.announcements', 'menu.edit', 'menu.reviews.view', 'community.polls', 'community.ideas', 'community.moderation', 'issues.view_all', 'issues.assign', 'issues.update', 'issues.manage_categories', 'issues.export', 'notifications.route', 'insights.view', 'users.view', 'users.create', 'users.edit', 'users.reset_password', 'users.change_roles', 'users.audit'], 'super_admin', FALSE, '',
    '{"types":{"issue_new":{"inapp":true},"issue_urgent":{"inapp":true},"issue_update":{"inapp":true},"announcement":{"inapp":true}}}'::jsonb)
ON CONFLICT DO NOTHING;
