// The single source of truth for permissions. The server checks them, the browser receives this exact catalogue through
// GET /api/bootstrap and GET /api/config (config.permissionCatalog), and a test keeps every permission string used in
// the code in sync with it. Nothing else should list permissions by hand.
//
// grant: 'any'      anyone who holds the permission may hand it on
//        'super'    only a super admin may grant it (it can be held by others, e.g. through a role)
//        'reserved' only the super admin role has it; it can never be granted to anyone else
export const PERMISSION_GROUPS = [
  { id: 'bookings', label: 'Bookings', icon: 'ticket', permissions: [
    { id: 'bookings.view_all', label: 'See everyone’s bookings', description: 'Open the bookings list, see who booked what and export bookings.' },
    { id: 'bookings.cancel_others', label: 'Cancel other people’s bookings', description: 'Cancel a booking made by someone else.' },
  ] },
  { id: 'events', label: 'Events', icon: 'party', permissions: [
    { id: 'events.create', label: 'Create events', description: 'Add new events.' },
    { id: 'events.edit', label: 'Edit events', description: 'Change the details of existing events.' },
    { id: 'events.delete', label: 'Delete events', description: 'Remove events for everyone.' },
  ] },
  { id: 'spaces', label: 'Spaces, teams and QR', icon: 'map', permissions: [
    { id: 'spaces.manage', label: 'Manage desks and rooms', description: 'Add, edit, place and retire desks and rooms; upload the floor plan.' },
    { id: 'teams.manage', label: 'Manage teams and seating', description: 'Create teams and assign seats to them.' },
    { id: 'qr.manage', label: 'Create QR codes', description: 'Create booking and “report a problem” QR codes.' },
  ] },
  { id: 'content', label: 'Content', icon: 'megaphone', permissions: [
    { id: 'content.links', label: 'Manage useful links', description: 'Add, edit and remove links and guides.' },
    { id: 'content.contacts', label: 'Manage important contacts', description: 'Add, edit and remove contacts.' },
    { id: 'content.announcements', label: 'Manage announcements', description: 'Post, edit and remove announcements (and notify everyone).' },
  ] },
  { id: 'menu', label: 'Food menu', icon: 'utensils', permissions: [
    { id: 'menu.edit', label: 'Edit the food menu', description: 'Enter and change daily menus and templates. Also lets you read the reviews.' },
    { id: 'menu.reviews.view', label: 'Read food reviews', description: 'Read the ratings and comments people leave on meals.' },
  ] },
  { id: 'community', label: 'Community', icon: 'heart', permissions: [
    { id: 'community.polls', label: 'Run polls', description: 'Create, close and delete polls.' },
    { id: 'community.ideas', label: 'Read the idea box', description: 'Read and triage ideas and suggestions.' },
    { id: 'community.moderation', label: 'Moderate community posts', description: 'Remove shout-outs and other community posts.' },
  ] },
  { id: 'issues', label: 'Facility issues', icon: 'wrench', permissions: [
    { id: 'issues.view_all', label: 'See all reported issues', description: 'Open the issue queue. Everyone can report a problem and follow their own reports without this.' },
    { id: 'issues.assign', label: 'Assign issues', description: 'Give an issue to a colleague.' },
    { id: 'issues.update', label: 'Work on issues', description: 'Change status and priority, add notes, take an issue. Can be assigned issues.' },
    { id: 'issues.manage_categories', label: 'Manage issue categories', description: 'Add, edit, reorder and switch off issue categories.' },
    { id: 'issues.export', label: 'Export issues', description: 'Download the issue list as a spreadsheet.' },
  ] },
  { id: 'notifications', label: 'Notifications', icon: 'bell', permissions: [
    { id: 'notifications.route', label: 'Choose who is notified', description: 'Decide which people and roles are notified, escalated to or assigned for each issue category.' },
  ] },
  { id: 'insights', label: 'Insights', icon: 'chart', permissions: [
    { id: 'insights.view', label: 'See the insights dashboard', description: 'Bookings, usage and sign-in numbers and trends.' },
  ] },
  { id: 'people', label: 'People and access', icon: 'users', permissions: [
    { id: 'users.view', label: 'See the people list', description: 'Open the People screen.', grant: 'super' },
    { id: 'users.create', label: 'Create people', description: 'Add accounts with a temporary password.', grant: 'super' },
    { id: 'users.edit', label: 'Edit people', description: 'Change names, teams, usernames, suspend or restore accounts.', grant: 'super' },
    { id: 'users.reset_password', label: 'Reset passwords', description: 'Give someone a new temporary password.', grant: 'super' },
    { id: 'users.change_roles', label: 'Change roles and permissions', description: 'Choose roles and tick permissions for people. You can only hand out what you hold yourself.', grant: 'super' },
    { id: 'users.audit', label: 'Read the activity log', description: 'Open and export the activity log.', grant: 'super' },
  ] },
  { id: 'system', label: 'System (super admin only)', icon: 'shield', permissions: [
    { id: 'settings.manage', label: 'Change app settings', description: 'Feature switches, branding and options. Only the super admin role has this.', grant: 'reserved' },
    { id: 'roles.manage', label: 'Manage roles', description: 'Create and edit roles and their default notifications. Only the super admin role has this.', grant: 'reserved' },
  ] },
];

export const PERMISSION_LIST = PERMISSION_GROUPS.flatMap((group) => group.permissions.map((permission) => ({ ...permission, grant: permission.grant ?? 'any', group: group.id })));
export const PERMISSIONS = Object.fromEntries(PERMISSION_LIST.map((permission) => [permission.id, permission.label]));
export const ALL_PERMISSIONS = PERMISSION_LIST.map((permission) => permission.id);
export const RESERVED_PERMISSIONS = PERMISSION_LIST.filter((permission) => permission.grant === 'reserved').map((permission) => permission.id);
export const SUPER_GRANT_PERMISSIONS = PERMISSION_LIST.filter((permission) => permission.grant === 'super').map((permission) => permission.id);
// Everything that can be stored on a person or a role.
export const GRANTABLE_PERMISSIONS = ALL_PERMISSIONS.filter((id) => !RESERVED_PERMISSIONS.includes(id));
export const ADMIN_DEFAULT_PERMISSIONS = GRANTABLE_PERMISSIONS.filter((id) => !SUPER_GRANT_PERMISSIONS.includes(id));

// Older, coarser permission strings that may still be stored on people and roles. They keep working: each one expands to
// the finer permissions that together cover everything it used to allow. Nothing is ever removed silently.
export const LEGACY_PERMISSIONS = {
  'bookings.manage': ['bookings.view_all', 'bookings.cancel_others'],
  'events.manage': ['events.create', 'events.edit', 'events.delete'],
  'content.manage': ['content.links', 'content.contacts', 'content.announcements'],
  'menu.manage': ['menu.edit', 'menu.reviews.view'],
  'community.manage': ['community.polls', 'community.ideas', 'community.moderation'],
  'users.manage': ['users.view', 'users.create', 'users.edit', 'users.reset_password', 'users.change_roles', 'users.audit'],
};

/** Turns any mix of current and legacy permission strings into the current ones (unknown strings are dropped). */
export function expandPermissions(list) {
  const out = new Set();
  for (const item of list ?? []) {
    if (LEGACY_PERMISSIONS[item]) LEGACY_PERMISSIONS[item].forEach((id) => out.add(id));
    else if (PERMISSIONS[item]) out.add(item);
  }
  return ALL_PERMISSIONS.filter((id) => out.has(id));
}

export const isLegacyPermission = (id) => Object.hasOwn(LEGACY_PERMISSIONS, id);

/** What the browser receives: groups with their permissions, plus which ones the “Admin” starting point includes. */
export const permissionCatalog = () => ({
  groups: PERMISSION_GROUPS.map((group) => ({
    id: group.id, label: group.label, icon: group.icon,
    permissions: group.permissions.map((permission) => ({ id: permission.id, label: permission.label, description: permission.description, grant: permission.grant ?? 'any' })),
  })),
  adminDefaults: ADMIN_DEFAULT_PERMISSIONS,
});
