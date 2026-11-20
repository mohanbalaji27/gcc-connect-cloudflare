// The single source of truth for every app setting. The server validates against it, the settings screen is drawn from it
// (it travels in the bootstrap for super admins), and tests walk through it. To add a setting, add ONE entry to SETTINGS:
//   { key, section, group, type, label, help, affects, default, min/max | options, legacy }
// Types: boolean | integer | enum | object (objects have their own validator below).
// Values are stored in the "settings_v2" row of app_settings as { key: value } for keys that were explicitly saved.
// `legacy: [row, field]` tells the reader where older installs kept the value, so nothing needs migrating.

export class SettingsError extends Error {}
const bad = (message) => { throw new SettingsError(message); };

export const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: 'sparkle', blurb: 'Name, colours, logo, sign-in page and Home layout.' },
  { id: 'features', label: 'Features', icon: 'grid', blurb: 'Switch whole parts of the app on or off.' },
  { id: 'booking', label: 'Booking rules', icon: 'desk', blurb: 'Limits and defaults for desks and rooms.' },
  { id: 'events', label: 'Events', icon: 'party', blurb: 'How events behave.' },
  { id: 'menu', label: 'Food menu', icon: 'utensils', blurb: 'Reviews and history for the menu.' },
  { id: 'issues', label: 'Issue box', icon: 'wrench', blurb: 'Problem reports.' },
  { id: 'notifications', label: 'Notifications', icon: 'bell', blurb: 'The bell and who gets what.' },
  { id: 'privacy', label: 'Privacy and analytics', icon: 'shield', blurb: 'What is counted and what people can see.' },
  { id: 'security', label: 'Security', icon: 'key', blurb: 'Passwords, sessions and sign-in protection.' },
  { id: 'data', label: 'Data', icon: 'doc', blurb: 'Backups and exports.' },
];

export const FEATURE_KEYS = {
  links: 'Useful links (user guides, portals)',
  contacts: 'Important contacts',
  menu: 'Food menu',
  announcements: 'Announcements',
  issues: 'Issue box (report a problem: coffee machine, tap, lights...)',
  kudos: 'Kudos wall (optional)',
  polls: 'Quick polls',
  celebrations: 'Birthdays and work anniversaries',
  feedback: 'Idea box (ideas and suggestions)',
  whosin: 'Who is in today',
  vibes: 'Points, levels and badges',
};
// Kudos is optional and off for brand-new installs. Existing installs keep whatever they stored (see migration 006).
export const DEFAULT_FEATURES = { ...Object.fromEntries(Object.keys(FEATURE_KEYS).map((key) => [key, true])), kudos: false };
export const OPTION_KEYS = {
  showBookerNames: 'Show who booked a seat or room in availability details',
  eventsRsvpEnabled: 'Let people tap “I’m going” on events',
  issuePhotosEnabled: 'Let people attach one small photo to an issue report',
  homeContacts: 'Show an Important contacts card on Home',
  usageAnalytics: 'Count which screens people open (usage analytics)',
};
export const DEFAULT_OPTIONS = { showBookerNames: false, eventsRsvpEnabled: true, issuePhotosEnabled: true, homeContacts: true, usageAnalytics: true };

export const ACCENTS = ['green', 'ocean', 'sunset', 'berry', 'mono', 'zimmer'];
// Primary colour of each preset: the web app manifest and the browser bar need it without running the UI code.
// A test keeps these equal to the presets in src/lib/theme.ts.
export const PRESET_PRIMARY = { green: '#1f7a56', ocean: '#1769a8', sunset: '#c44a1d', berry: '#a62b7a', mono: '#3b4a45', zimmer: '#0067b1' };
export const PRESET_STRONG = { green: '#123d2d', ocean: '#0d3555', sunset: '#5a1f0e', berry: '#4a0f38', mono: '#161d1a', zimmer: '#003c71' };
export const STAY_CODES = ['d60', 'd120', 'd240', 'd480', 'u1700', 'u2000', 'u2400'];

const FEATURE_INFO = {
  links: ['Useful links: user guides and portals, grouped by category. Managers edit them in Manage → Content.', 'Everyone. Managers can still edit while it is off.'],
  contacts: ['Important contacts: security, facilities, IT and more, with tap-to-call.', 'Everyone. Managers can still edit while it is off.'],
  menu: ['The menu card, the quick day editor for the food team, dish likes and meal reviews. Menus and reviews stay saved while it is off.', 'Everyone; the food team keeps editing access.'],
  announcements: ['News banners on Home. Pinned ones stay on top until they expire.', 'Everyone sees them; managers post them.'],
  issues: ['Report a problem: tiles for the coffee machine, washrooms, lights and more. Managers choose categories and who is notified under Manage → Issue box.', 'Everyone can report; the facility team gets the tasks.'],
  kudos: ['Optional recognition wall. Off for new installs; existing installs keep what they had.', 'Everyone.'],
  polls: ['Quick one-question polls with live results.', 'Everyone votes; managers create polls.'],
  celebrations: ['Birthdays and work anniversaries on Home and in Community. People choose to add their birthday.', 'Everyone.'],
  feedback: ['The Idea box is only for ideas and suggestions. Broken things go to the issue box.', 'Everyone can post; the people who handle ideas read them.'],
  whosin: ['A friendly list of who booked a desk today. People can hide themselves in Me.', 'Everyone.'],
  vibes: ['Points, levels and badges for using the app.', 'Everyone.'],
};
const OPTION_INFO = {
  showBookerNames: ['section:booking', 'Off by default: people only see that a seat is booked and for when. Managers who can see bookings always see names.', 'Everyone who looks at seat or room details.'],
  eventsRsvpEnabled: ['section:events', 'Turn off to hide the “I’m going” button and the going counts on events.', 'Everyone on the Events screen and Home.'],
  issuePhotosEnabled: ['section:issues', 'On by default. People can attach one small photo (shrunk in their browser to about 200 KB) to a problem report. Turn off to stop accepting photos.', 'People reporting problems and the facility team.'],
  homeContacts: ['section:features', 'Home shows the contacts marked “Show on Home” (Manage → Content → Contacts). If none are marked, it shows the first emergency contacts. Needs the Important contacts feature to be on.', 'Everyone on Home.'],
  usageAnalytics: ['section:privacy', 'On by default. Counts how often each screen is opened and how many people sign in each day, for the Usage dashboard. See exactly what is collected below. Turning it off stops counting straight away.', 'Everyone (counting only; nothing they type is collected).'],
};

export const SETTINGS = [
  ...Object.entries(FEATURE_KEYS).map(([name, label]) => ({
    key: `features.${name}`, section: 'features', group: 'Switches', type: 'boolean', label, help: FEATURE_INFO[name][0], affects: FEATURE_INFO[name][1], default: DEFAULT_FEATURES[name], legacy: ['features', name],
  })),
  ...Object.entries(OPTION_KEYS).map(([name, label]) => ({
    key: `options.${name}`, section: OPTION_INFO[name][0].slice(8), group: 'Options', type: 'boolean', label, help: OPTION_INFO[name][1], affects: OPTION_INFO[name][2], default: DEFAULT_OPTIONS[name], legacy: ['options', name],
  })),
  { key: 'homeContactsCount', section: 'features', group: 'Options', type: 'integer', min: 1, max: 6, label: 'Contacts shown on Home', help: 'How many Important contacts the Home card shows (only when the Home contacts option is on).', affects: 'Everyone on Home.', default: 4, legacy: ['general_settings', 'homeContactsCount'] },

  { key: 'booking.maxAdvanceDays', section: 'booking', group: 'Limits', type: 'integer', min: 1, max: 365, unit: 'days', label: 'How far ahead people can book', help: 'The date picker and the server both stop at this many days from today.', affects: 'Everyone booking a desk or room.', default: 60 },
  { key: 'booking.quotaPerPerson', section: 'booking', group: 'Limits', type: 'integer', min: 1, max: 20, label: 'Upcoming bookings per person', help: 'How many bookings that have not ended yet one person can hold at a time.', affects: 'Everyone booking.', default: 3 },
  { key: 'booking.roomMaxHours', section: 'booking', group: 'Limits', type: 'integer', min: 1, max: 24, unit: 'hours', label: 'Longest room booking', help: 'Room bookings longer than this are refused. Desks can be booked up to a full day.', affects: 'Everyone booking a room.', default: 8 },
  { key: 'booking.defaultStay', section: 'booking', group: 'Defaults', type: 'enum', options: [['d60', '1 hour'], ['d120', '2 hours'], ['d240', '4 hours'], ['d480', 'Full day (8 h)'], ['u1700', 'Until 5:00 pm'], ['u2000', 'Until 8:00 pm'], ['u2400', 'Until midnight']], label: 'Default stay', help: 'The length of stay that is pre-selected for people who have not booked before. People who did keep their last choice.', affects: 'New bookers and QR booking.', default: 'd240' },
  { key: 'booking.officeFrom', section: 'booking', group: 'Office hours', type: 'integer', min: 0, max: 23, unit: 'o’clock', label: 'Office opens', help: 'Used by analytics to work out how busy desks and rooms are (24-hour clock, IST). It does not stop anyone from booking.', affects: 'Insights dashboard.', default: 9 },
  { key: 'booking.officeTo', section: 'booking', group: 'Office hours', type: 'integer', min: 1, max: 24, unit: 'o’clock', label: 'Office closes', help: 'The end of the working day for analytics (24-hour clock, IST). Must be later than the opening hour.', affects: 'Insights dashboard.', default: 18 },

  { key: 'menuReviewsVisibility', section: 'menu', group: 'Reviews', type: 'enum', options: [['everyone', 'Everyone sees everything'], ['summary', 'Everyone sees the average, the food team reads comments'], ['managers', 'Only the food team sees reviews']], label: 'Who can read menu reviews', help: 'Everyone: average stars and comments are public, with the writer’s name unless they posted anonymously. Average only (default): comments and names go to the food team. Food team only: people see just their own review. “Food team” means anyone with the Manage the food menu or Read food menu reviews permission.', affects: 'Everyone on the Menu screen.', default: 'summary', legacy: ['menu_settings', 'menuReviewsVisibility'] },
  { key: 'menuHistoryDays', section: 'menu', group: 'History', type: 'integer', min: 1, max: 90, unit: 'days', label: 'Days of menu history to keep', help: 'Menus and their reviews older than this are removed automatically, once a day. Seven keeps the last week visible on the menu card.', affects: 'Everyone on the Menu screen.', default: 7, legacy: ['menu_settings', 'menuHistoryDays'] },

  { key: 'issues.reopenDays', section: 'issues', group: 'Reports', type: 'integer', min: 1, max: 60, unit: 'days', label: 'Reopen window', help: 'How long after a fix the reporter can tap “Still not fixed”.', affects: 'People who report problems.', default: 7 },

  { key: 'notifications.retentionDays', section: 'notifications', group: 'Bell', type: 'integer', min: 7, max: 365, unit: 'days', label: 'Keep notifications for', help: 'Older notifications are removed automatically, once a day. Who receives which notification is set per role (Manage → Roles) and per person (Me).', affects: 'Everyone’s bell.', default: 30 },

  { key: 'usageRetentionDays', section: 'privacy', group: 'Retention', type: 'integer', min: 30, max: 1095, unit: 'days', label: 'Days to keep usage data', help: 'Older usage counts and sign-in history are removed automatically, once a day (400 by default).', affects: 'Usage dashboard and the activity log.', default: 400, legacy: ['general_settings', 'usageRetentionDays'] },

  { key: 'security.passwordMinLength', section: 'security', group: 'Passwords', type: 'integer', min: 8, max: 64, unit: 'characters', label: 'Minimum password length', help: 'Enforced when people change their password. Existing passwords keep working until changed.', affects: 'Everyone changing a password.', default: 10 },
  { key: 'security.sessionHours', section: 'security', group: 'Sign-in', type: 'integer', min: 1, max: 168, unit: 'hours', label: 'Stay signed in for', help: 'How long a new sign-in lasts before asking again. Applies to sign-ins from now on.', affects: 'Everyone, from their next sign-in.', default: 8 },
  { key: 'security.lockoutAttempts', section: 'security', group: 'Sign-in', type: 'integer', min: 3, max: 20, label: 'Wrong passwords before a pause', help: 'After this many failed tries for one account from one device, sign-in pauses.', affects: 'Everyone signing in.', default: 8 },
  { key: 'security.lockoutMinutes', section: 'security', group: 'Sign-in', type: 'integer', min: 5, max: 240, unit: 'minutes', label: 'Length of the pause', help: 'How long sign-in stays paused after too many wrong passwords.', affects: 'Everyone signing in.', default: 15 },

  { key: 'branding', section: 'appearance', group: 'Look and voice', type: 'object', label: 'Name, colours and logo', help: 'App name, tagline, colour theme and logo placement.', affects: 'Everyone.', default: null },
  { key: 'login', section: 'appearance', group: 'Sign-in page', type: 'object', label: 'Sign-in page', help: 'Texts, background, card style and footer of the sign-in page.', affects: 'Everyone, before they sign in.', default: null },
  { key: 'home', section: 'appearance', group: 'Home', type: 'object', label: 'Home layout', help: 'Order and visibility of the Home cards, and the greeting.', affects: 'Everyone on Home.', default: null },
];

export const SETTING_BY_KEY = new Map(SETTINGS.map((setting) => [setting.key, setting]));
export const SCALAR_SETTINGS = SETTINGS.filter((setting) => setting.type !== 'object');

// ---------- Objects: branding, login page, home ----------
const HEX = /^#[0-9a-f]{6}$/i;
const hex = (value, label) => (typeof value === 'string' && HEX.test(value.trim()) ? value.trim().toLowerCase() : bad(`${label} must be a colour like #0067b1.`));
const str = (value, max, label, { required = false } = {}) => {
  if (value === undefined || value === null) return required ? bad(`${label} is required.`) : '';
  if (typeof value !== 'string') return bad(`${label} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) return bad(`${label} is required.`);
  return trimmed.length > max ? bad(`${label} must be ${max} characters or fewer.`) : trimmed;
};
const pick = (value, allowed, label) => (allowed.includes(value) ? value : bad(`Choose a valid ${label}.`));
const flag = (value, label) => (typeof value === 'boolean' ? value : bad(`${label} must be on or off.`));
const whole = (value, min, max, label) => (Number.isInteger(value) && value >= min && value <= max ? value : bad(`${label} must be a whole number from ${min} to ${max}.`));

export const THEME_FIELDS = ['primary', 'primaryStrong', 'accent', 'neutral', 'surface', 'ink', 'success', 'warn', 'danger'];
export function cleanTheme(input) {
  if (input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) return bad('The theme must be a set of colours.');
  const theme = { name: str(input.name, 30, 'Theme name', { required: true }) };
  for (const field of THEME_FIELDS) theme[field] = hex(input[field], `The ${field} colour`);
  if (input.base !== undefined && input.base !== null && input.base !== '') theme.base = pick(input.base, ACCENTS, 'base theme');
  return theme;
}

export const DEFAULT_BRANDING = {
  appName: 'GCC Connect', shortName: '', tagline: 'Your office day, sorted.', welcome: '', accent: 'green', theme: null,
  logoHeight: 32, logoAlign: 'left', logoDisplay: 'logo',
};
const BRANDING_RULES = {
  appName: (v) => str(v, 40, 'App name', { required: true }),
  shortName: (v) => str(v, 12, 'Short name'),
  tagline: (v) => str(v, 80, 'Tagline'),
  welcome: (v) => str(v, 200, 'Welcome note'),
  accent: (v) => pick(v, [...ACCENTS, 'custom'], 'colour theme'),
  theme: cleanTheme,
  logoHeight: (v) => whole(v, 20, 40, 'Logo height'),
  logoAlign: (v) => pick(v, ['left', 'center'], 'logo alignment'),
  logoDisplay: (v) => pick(v, ['logo', 'logo-text', 'text'], 'logo style'),
};

export const HOME_CARDS = [
  { id: 'hero', label: 'Greeting and next booking', hint: 'The big card at the top.' },
  { id: 'news', label: 'Announcements', hint: 'Pinned news (needs the Announcements feature).' },
  { id: 'stats', label: 'Desks free, streak and level', hint: 'The three numbers row and badges.' },
  { id: 'quick', label: 'Quick actions', hint: 'Book a desk, book a room, scan, events, report a problem.' },
  { id: 'menu', label: 'Menu today', hint: 'Needs the Food menu feature.' },
  { id: 'whosin', label: 'Who’s in today', hint: 'Needs the Who is in feature.' },
  { id: 'celebrate', label: 'Birthdays and anniversaries', hint: 'Needs the Celebrations feature.' },
  { id: 'contacts', label: 'Important contacts', hint: 'Also needs the “Important contacts on Home” option.' },
  { id: 'links', label: 'Quick links', hint: 'Needs the Useful links feature.' },
  { id: 'events', label: 'Coming up (events)', hint: 'The next events.' },
  { id: 'tip', label: 'Tip of the day', hint: 'One friendly tip at the bottom.' },
];
export const DEFAULT_HOME = { layout: HOME_CARDS.map((card) => ({ id: card.id, on: true })), greeting: '' };
export function cleanHomeLayout(input) {
  if (!Array.isArray(input) || input.length > HOME_CARDS.length) return bad('The Home layout must list each card once.');
  const seen = new Set();
  const layout = input.map((item) => {
    if (!item || typeof item !== 'object' || !HOME_CARDS.some((card) => card.id === item.id)) return bad('The Home layout contains a card that does not exist.');
    if (seen.has(item.id)) return bad('Each Home card can appear only once.');
    seen.add(item.id);
    return { id: item.id, on: flag(item.on, 'Card visibility') };
  });
  // Cards missing from an older or partial layout are added at the end, switched on, so a new card never disappears.
  for (const card of HOME_CARDS) if (!seen.has(card.id)) layout.push({ id: card.id, on: true });
  return layout;
}
const HOME_RULES = {
  layout: cleanHomeLayout,
  greeting: (v) => str(v, 80, 'Greeting'),
};

export const LOGIN_BACKGROUNDS = ['gradient', 'solid', 'pattern', 'image'];
export const LOGIN_CARDS = ['solid', 'glass', 'outlined'];
export const DEFAULT_LOGIN = {
  title: '', subtitle: '', cardTitle: 'Welcome back', cardText: 'Sign in to {app}.', background: 'gradient', card: 'solid',
  showLogo: true, showTip: false, bullets: ['Real floor plan, live availability', 'One tap to book, one scan to find', 'Events, food, kudos and fun'],
  footerText: '', footerLinks: [], forgotHelp: 'Forgot your password? Ask your workplace team or a super admin to reset it.', usernameHint: '',
};
function cleanFooterLinks(input) {
  if (!Array.isArray(input) || input.length > 3) return bad('Add up to three footer links.');
  return input.map((item) => {
    const label = str(item?.label, 30, 'Footer link name', { required: true });
    const url = str(item?.url, 300, 'Footer link address', { required: true });
    // https only (plus mailto/tel for contact links): nothing that could run script.
    if (!/^(https?:\/\/[^\s]+\.[^\s]+|mailto:[^\s]+@[^\s]+|tel:[+\d\s()-]{3,25})$/i.test(url)) return bad(`“${label}” needs a web address starting with https://, or a mailto: / tel: link.`);
    return { label, url };
  });
}
const LOGIN_RULES = {
  title: (v) => str(v, 80, 'Sign-in headline'),
  subtitle: (v) => str(v, 240, 'Sign-in subtitle'),
  cardTitle: (v) => str(v, 60, 'Card title', { required: true }),
  cardText: (v) => str(v, 120, 'Card text'),
  background: (v) => pick(v, LOGIN_BACKGROUNDS, 'background style'),
  card: (v) => pick(v, LOGIN_CARDS, 'card style'),
  showLogo: (v) => flag(v, 'Show logo'),
  showTip: (v) => flag(v, 'Show a tip'),
  bullets: (v) => (Array.isArray(v) && v.length <= 4 ? v.map((item) => str(item, 80, 'Highlight', { required: true })) : bad('Add up to four highlights.')),
  footerText: (v) => str(v, 160, 'Footer text'),
  footerLinks: cleanFooterLinks,
  forgotHelp: (v) => str(v, 200, 'Forgot-password help'),
  usernameHint: (v) => str(v, 120, 'Sign-in hint'),
};

const OBJECTS = {
  branding: { rules: BRANDING_RULES, defaults: DEFAULT_BRANDING },
  home: { rules: HOME_RULES, defaults: DEFAULT_HOME },
  login: { rules: LOGIN_RULES, defaults: DEFAULT_LOGIN },
};
export const OBJECT_KEYS = Object.keys(OBJECTS);

// Merges a partial object change into the current value, rejecting unknown fields.
export function mergeObject(key, current, input) {
  const { rules, defaults } = OBJECTS[key];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return bad(`${SETTING_BY_KEY.get(key).label} must be a set of fields.`);
  const next = { ...defaults, ...(current ?? {}) };
  for (const [field, value] of Object.entries(input)) {
    if (!(field in rules)) return bad(`Unknown ${key} setting “${field}”.`);
    next[field] = rules[field](value);
  }
  if (key === 'branding' && next.accent === 'custom' && !next.theme) return bad('Pick the colours of your custom theme first.');
  return next;
}

export function resolveObject(key, stored) {
  const { defaults } = OBJECTS[key];
  const merged = { ...defaults, ...(stored && typeof stored === 'object' ? stored : {}) };
  if (key === 'home') merged.layout = (() => { try { return cleanHomeLayout(merged.layout); } catch { return defaults.layout; } })();
  return merged;
}

// ---------- Scalars ----------
export function cleanScalar(setting, value) {
  const label = setting.label;
  if (setting.type === 'boolean') return typeof value === 'boolean' ? value : bad(`${label} must be on or off.`);
  if (setting.type === 'integer') return Number.isInteger(value) && value >= setting.min && value <= setting.max ? value : bad(`${label} must be a whole number from ${setting.min} to ${setting.max}.`);
  if (setting.type === 'enum') return setting.options.some(([id]) => id === value) ? value : bad(`Choose one of the listed options for “${label}”.`);
  return bad(`“${label}” cannot be set that way.`);
}

// Where a stored value lives: the new flat row first, then the legacy row of older installs, then the default.
export function resolveScalar(setting, flat, legacyRows) {
  if (flat && Object.hasOwn(flat, setting.key)) {
    try { return cleanScalar(setting, flat[setting.key]); } catch { /* a bad stored value falls through to the default */ }
  }
  if (setting.legacy) {
    const [row, field] = setting.legacy;
    const stored = legacyRows?.[row]?.[field];
    if (stored !== undefined) { try { return cleanScalar(setting, stored); } catch { /* ignore */ } }
  }
  return setting.default;
}

export function resolveAll(rows) {
  const flat = rows.settings_v2 ?? {};
  const values = {};
  for (const setting of SCALAR_SETTINGS) values[setting.key] = resolveScalar(setting, flat, rows);
  // Opening hours must stay in order even if someone stored nonsense.
  if (values['booking.officeFrom'] >= values['booking.officeTo']) { values['booking.officeFrom'] = 9; values['booking.officeTo'] = 18; }
  const objects = Object.fromEntries(OBJECT_KEYS.map((key) => [key, resolveObject(key, flat[key] ?? (key === 'branding' ? rows.branding : undefined))]));
  return { values, ...objects };
}

// Turns the older request shapes ({ features: {...}, options: {...}, branding: {...}, menuHistoryDays: 7 }) into flat keys.
export function flattenRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Send the settings you want to change.');
  const changes = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'settings') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('Settings must be a set of keys and values.');
      Object.assign(changes, value);
    } else if (key === 'features' || key === 'options') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return bad(key === 'features' ? 'Features must be on/off switches.' : 'Options must be on/off switches.');
      for (const [name, on] of Object.entries(value)) {
        if (!SETTING_BY_KEY.has(`${key}.${name}`)) return bad(`Unknown ${key === 'features' ? 'feature' : 'option'} “${name}”.`);
        changes[`${key}.${name}`] = on;
      }
    } else changes[key] = value;
  }
  return changes;
}

export const describeValue = (value) => {
  if (value && typeof value === 'object') return JSON.stringify(value).slice(0, 40);
  return typeof value === 'string' ? `“${value.slice(0, 40)}”` : String(value);
};

// What the browser needs to draw the settings console (sent to super admins only).
export const settingsSchema = () => ({
  sections: SECTIONS,
  settings: SETTINGS.map(({ key, section, group, type, label, help, affects, default: def, min, max, unit, options }) => ({ key, section, group, type, label, help, affects, default: def, min, max, unit, options })),
  homeCards: HOME_CARDS,
  themeFields: THEME_FIELDS,
});
