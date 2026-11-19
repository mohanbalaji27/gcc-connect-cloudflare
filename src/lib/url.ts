// Shared handling for every web address typed or pasted into the app.
const SCHEME = /^\s*(https?)(?::\/{1,2}|\/\/)/i;

export interface SplitUrl { scheme: 'http' | 'https'; rest: string; explicit: boolean }

// "https://https://x.com", "HTTP://x.com", "x.com" and " x.com " all become a scheme plus what comes after it.
export function splitUrl(raw: string, fallback: 'http' | 'https' = 'https'): SplitUrl {
  let rest = raw;
  let scheme: 'http' | 'https' = fallback;
  let explicit = false;
  for (let guard = 0; guard < 5; guard += 1) {
    const match = SCHEME.exec(rest);
    if (!match) break;
    if (!explicit) { scheme = match[1].toLowerCase() as 'http' | 'https'; explicit = true; }
    rest = rest.slice(match[0].length);
  }
  return { scheme, rest: rest.replace(/^\s+/, ''), explicit };
}

// Turns whatever a person typed into a full address ("" stays empty). Other schemes (javascript:, ftp:, ...) are left
// untouched so that validation can reject them.
export function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !SCHEME.test(value) && !/^[a-z0-9.-]+:\d+(\/|$)/i.test(value)) return value;
  const { scheme, rest } = splitUrl(value);
  const trimmed = rest.trim();
  return trimmed ? `${scheme}://${trimmed}` : '';
}

// Returns a friendly problem description, or null when the address is fine (or empty).
export function urlProblem(raw: string): string | null {
  const value = normalizeUrl(raw);
  if (!value) return null;
  if (value.length > 500) return 'That address is too long.';
  if (/\s/.test(value)) return 'Web addresses cannot contain spaces.';
  let url: URL;
  try { url = new URL(value); } catch { return 'That does not look like a web address. Try something like example.com/page.'; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Use a web address that starts with https://';
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return 'That address needs a domain, like example.com.';
  return null;
}
