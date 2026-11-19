import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

import { ALL_PERMISSIONS, RESERVED_PERMISSIONS, expandPermissions } from './permissions.js';

export {
  PERMISSIONS, ALL_PERMISSIONS, GRANTABLE_PERMISSIONS, ADMIN_DEFAULT_PERMISSIONS, SUPER_GRANT_PERMISSIONS, RESERVED_PERMISSIONS, LEGACY_PERMISSIONS, expandPermissions, permissionCatalog,
} from './permissions.js';
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
  if (employee.role === 'super_admin') return ALL_PERMISSIONS;
  // Older stored strings (for example `menu.manage`) are expanded, so nobody loses access when permissions get finer.
  // Reserved permissions belong to the super admin role alone, whatever a stored list says.
  return expandPermissions([...(employee.permissions ?? []), ...(employee.role_permissions ?? [])]).filter((id) => !RESERVED_PERMISSIONS.includes(id));
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
