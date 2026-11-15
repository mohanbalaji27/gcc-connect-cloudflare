import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const PERMISSIONS = {
  'bookings.manage': 'View and cancel anyone’s bookings',
  'events.manage': 'Create, edit and delete events',
  'spaces.manage': 'Add, edit, place and retire desks and rooms',
  'teams.manage': 'Create teams and assign seats to them',
  'qr.manage': 'Create booking QR codes',
  'users.manage': 'Create users, change roles and permissions, reset passwords',
  'content.manage': 'Manage links, contacts and announcements',
  'menu.manage': 'Manage the food menu',
  'community.manage': 'Run polls, moderate kudos, read the feedback box',
  'insights.view': 'See the insights dashboard',
};
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS);
export const ADMIN_DEFAULT_PERMISSIONS = ALL_PERMISSIONS.filter((permission) => permission !== 'users.manage');
export const SUPER_ONLY_PERMISSIONS = ['users.manage'];
export const ROLES = ['user', 'admin', 'super_admin'];

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// Stored as "salt:hash[:N]". N is the scrypt cost; older hashes without it use 16384, so they keep working.
// Lower PASSWORD_SCRYPT_N (a power of two, e.g. 4096) only if your host caps CPU time per request, such as Cloudflare's free plan.
const DEFAULT_SCRYPT_N = 16384;
const scryptCost = () => {
  const n = Number(process.env.PASSWORD_SCRYPT_N ?? DEFAULT_SCRYPT_N);
  return Number.isInteger(n) && n >= 2048 && n <= 1_048_576 && (n & (n - 1)) === 0 ? n : DEFAULT_SCRYPT_N;
};
const derive = (password, salt, N) => scryptSync(password, salt, 64, { N, maxmem: 1100 * N + 4_000_000 });

export function hashPassword(password) {
  const salt = randomBytes(16);
  const N = scryptCost();
  return `${salt.toString('hex')}:${derive(password, salt, N).toString('hex')}:${N}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex, cost] = (stored ?? '').split(':');
  const N = Number(cost ?? DEFAULT_SCRYPT_N);
  const usable = Boolean(hashHex) && Number.isInteger(N) && N >= 2048 && N <= 1_048_576 && (N & (N - 1)) === 0;
  const expected = usable ? Buffer.from(hashHex, 'hex') : Buffer.alloc(64);
  const actual = derive(password || 'invalid', Buffer.from(saltHex || '00', 'hex'), usable ? N : 2048);
  return usable && expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function generatePassword() {
  return randomBytes(9).toString('base64url');
}

export function effectivePermissions(employee) {
  if (employee.role === 'super_admin') return ALL_PERMISSIONS;
  const merged = new Set([...(employee.permissions ?? []), ...(employee.role_permissions ?? [])]);
  return ALL_PERMISSIONS.filter((permission) => merged.has(permission));
}
// Accepts only http(s) links so a stored URL can never be a javascript: or data: address.
export function safeUrl(value, label = 'Link') {
  const fail = (message) => Object.assign(new Error(message), { status: 400, code: 'INVALID_URL' });
  if (typeof value !== 'string' || value.length > 500) throw fail(`${label} must be a web address.`);
  let url;
  try { url = new URL(value.trim()); } catch { throw fail(`${label} is not a valid web address. Include https://`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw fail(`${label} must start with http:// or https://`);
  return url.toString();
}

export function cleanLinks(value) {
  const fail = (message) => Object.assign(new Error(message), { status: 400, code: 'INVALID_LINKS' });
  if (!Array.isArray(value) || value.length > 6) throw fail('Add up to 6 links.');
  return value.map((item) => {
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    if (!label || label.length > 60) throw fail('Each link needs a short label.');
    return { label, url: safeUrl(item?.url, `\u201c${label}\u201d`) };
  });
}
