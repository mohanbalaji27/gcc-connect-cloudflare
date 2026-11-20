import express from 'express';
import { createHash } from 'node:crypto';
import { PRESET_PRIMARY, PRESET_STRONG } from './settings-registry.js';

// Logo and sign-in image storage (app_files) and the public pieces that depend on them: the logo files, the generated
// fallback icon and the web app manifest. Colours and texts come from the settings (branding), never from the request.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_END = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
const KB = 1024;

// maxW / maxH are pixel caps; the browser produces these sizes (see src/lib/logoProcess.ts), the server enforces the caps.
export const LOGO_SLOTS = {
  header: { maxW: 800, maxH: 96, maxBytes: 80 * KB, required: true },
  login: { maxW: 1024, maxH: 256, maxBytes: 160 * KB, required: true },
  icon192: { maxW: 192, maxH: 192, maxBytes: 60 * KB, required: true },
  icon512: { maxW: 512, maxH: 512, maxBytes: 200 * KB, required: true },
  favicon: { maxW: 64, maxH: 64, maxBytes: 30 * KB, required: true },
  headerDark: { maxW: 800, maxH: 96, maxBytes: 80 * KB, required: false },
  loginDark: { maxW: 1024, maxH: 256, maxBytes: 160 * KB, required: false },
};
export const LOGIN_IMAGE_MAX_BYTES = 300 * KB;
const fileKey = (slot) => `brand-${slot}`;
const BG_KEY = 'brand-login-bg';

export const sha = (...parts) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
};

// Returns { width, height } for a well-formed PNG, or null. Only the structure is checked: signature, header chunk, end chunk.
export function pngInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 45) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.toString('latin1', 12, 16) !== 'IHDR') return null;
  if (!buffer.subarray(buffer.length - 12).equals(PNG_END)) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function imageKind(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const mix = (a, b, amount) => {
  const parse = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [parse(a), parse(b)];
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * amount).toString(16).padStart(2, '0')).join('')}`;
};

export const primaryOf = (branding) => (branding.accent === 'custom' && branding.theme ? branding.theme.primary : PRESET_PRIMARY[branding.accent] ?? PRESET_PRIMARY.green);
export const strongOf = (branding) => (branding.accent === 'custom' && branding.theme ? branding.theme.primaryStrong : PRESET_STRONG[branding.accent] ?? PRESET_STRONG.green);
const escapeXml = (value) => value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);

export function fallbackIconSvg(branding) {
  const letter = escapeXml(([...(branding.shortName || branding.appName).trim()][0] ?? 'G').toUpperCase());
  const primary = primaryOf(branding);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="19" fill="${primary}"/><text x="32" y="44" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="700" fill="#ffffff">${letter}</text></svg>`;
}

export function manifestFor(branding, logo) {
  const primary = primaryOf(branding);
  const strong = strongOf(branding);
  const name = branding.appName;
  const icons = logo?.slots?.includes('icon192') && logo.slots.includes('icon512')
    ? ['icon192', 'icon512'].flatMap((slot) => ['any', 'maskable'].map((purpose) => ({ src: `/api/branding/logo?slot=${slot}&v=${logo.v}`, sizes: slot === 'icon192' ? '192x192' : '512x512', type: 'image/png', purpose })))
    : [{ src: '/api/branding/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }];
  return {
    name, short_name: (branding.shortName || name).slice(0, 12), description: branding.tagline || `Plan your office day with ${name}.`,
    id: '/', start_url: '/', scope: '/', display: 'standalone', background_color: mix(primary, '#ffffff', 0.94), theme_color: strong, icons,
  };
}

export function registerBranding({ app, db, requireSuper, requireCsrf, audit, fail, readSettings }) {
  // One request carries everything the sign-in page needs (texts, theme, logo version). The ETag makes repeat visits a 304.
  app.get('/api/public-config', async (_req, res) => {
    const { branding, login, logo, values } = await readSettings();
    res.set('Cache-Control', 'no-cache');
    res.json({ branding, login, logo, passwordMinLength: values['security.passwordMinLength'] });
  });

  const serve = (keyOf, suffixOf) => async (req, res) => {
    const slot = req.query.slot;
    const v = typeof req.query.v === 'string' && /^[a-f0-9]{8,64}$/.test(req.query.v) ? req.query.v : null;
    // now() keeps Hyperdrive from serving a cached copy of an image that was just replaced.
    const row = (await db.query('SELECT content_type, data, now() AS read_at FROM app_files WHERE key = $1', [keyOf(slot)])).rows[0];
    if (!row) throw fail(404, 'NOT_FOUND', 'No image has been set.');
    const buffer = Buffer.from(row.data);
    res.set({
      'Content-Type': row.content_type,
      'Content-Length': buffer.length,
      ETag: `"${v ?? sha(buffer).slice(0, 24)}${suffixOf(slot)}"`,
      // The address changes with the image (?v=), so a browser can keep it for good; without ?v= it must ask each time.
      'Cache-Control': v ? 'public, max-age=31536000, immutable' : 'public, no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    if (req.fresh) return res.status(304).end();
    return res.end(buffer);
  };
  const serveLogo = serve((slot) => fileKey(slot), (slot) => `-${slot}`);
  const serveBackground = serve(() => BG_KEY, () => '-bg');
  app.get('/api/branding/logo', (req, res, next) => {
    if (!Object.hasOwn(LOGO_SLOTS, req.query.slot)) return next(fail(404, 'NOT_FOUND', 'No image has been set.'));
    return serveLogo(req, res).catch(next);
  });
  app.get('/api/branding/login-image', (req, res, next) => serveBackground(req, res).catch(next));

  app.get('/api/branding/icon.svg', async (_req, res) => {
    const { branding } = await readSettings();
    res.set({ 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, no-cache', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.send(fallbackIconSvg(branding));
  });

  // The manifest is generated so the installed app carries the name, colour and logo chosen in Settings.
  app.get('/manifest.webmanifest', async (_req, res) => {
    let body;
    try {
      const { branding, logo } = await readSettings();
      body = manifestFor(branding, logo);
    } catch {
      body = { name: 'GCC Connect', short_name: 'GCC Connect', start_url: '/', display: 'standalone', background_color: '#f7f8f4', theme_color: '#1f7a56', icons: [{ src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] };
    }
    res.set({ 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'public, no-cache' });
    res.send(JSON.stringify(body));
  });

  const metaOf = (stored) => ({ slots: [], hashes: {}, bg: null, v: '', ...(stored ?? {}) });
  const versionOf = (slots, hashes, bg) => sha(JSON.stringify([...slots].sort().map((slot) => [slot, hashes[slot]])), bg ?? '').slice(0, 16);
  const readMeta = async (tx) => metaOf((await tx.query("SELECT value FROM app_settings WHERE key = 'brand_meta'")).rows[0]?.value);
  const writeMeta = (tx, meta) => tx.query("INSERT INTO app_settings (key, value) VALUES ('brand_meta', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [JSON.stringify(meta)]);

  const decode = (slot, input) => {
    const spec = LOGO_SLOTS[slot];
    if (typeof input !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input)) throw fail(400, 'INVALID_LOGO', `The “${slot}” image could not be read.`);
    const buffer = Buffer.from(input, 'base64');
    if (buffer.length > spec.maxBytes) throw fail(400, 'LOGO_TOO_LARGE', `The “${slot}” image is too large (limit ${Math.round(spec.maxBytes / KB)} KB). Try a simpler logo.`);
    const info = pngInfo(buffer);
    if (!info) throw fail(415, 'INVALID_LOGO', 'Logos must be PNG images prepared by the logo tool. Choose the file again in Settings.');
    if (info.width > spec.maxW || info.height > spec.maxH) throw fail(400, 'LOGO_DIMENSIONS', `The “${slot}” image is larger than ${spec.maxW}×${spec.maxH} pixels.`);
    return buffer;
  };

  const upsertFile = (tx, key, type, data, userId) => tx.query(
    `INSERT INTO app_files (key, content_type, data, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO UPDATE SET content_type = excluded.content_type, data = excluded.data, updated_at = now(), updated_by = excluded.updated_by`,
    [key, type, data, userId],
  );
  const reply = async (res, version) => {
    res.set('X-Config-Version', String(version));
    res.json({ logo: (await readSettings()).logo, configVersion: version });
  };

  app.put('/api/admin/branding/logo', requireSuper, requireCsrf, async (req, res) => {
    const input = req.body?.slots;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'INVALID_LOGO', 'Send the logo images to store.');
    const files = {};
    for (const [slot, data] of Object.entries(input)) {
      if (!Object.hasOwn(LOGO_SLOTS, slot)) throw fail(400, 'INVALID_LOGO', `Unknown logo slot “${slot}”.`);
      files[slot] = decode(slot, data);
    }
    const dropDark = req.body?.dropDark === true;
    const version = await db.tx(async (tx) => {
      const meta = await readMeta(tx);
      const hashes = { ...meta.hashes };
      const slots = new Set(meta.slots);
      for (const [slot, buffer] of Object.entries(files)) {
        await upsertFile(tx, fileKey(slot), 'image/png', buffer, req.user.id);
        hashes[slot] = sha(buffer).slice(0, 16);
        slots.add(slot);
      }
      if (dropDark) {
        for (const slot of ['headerDark', 'loginDark']) {
          if (files[slot]) continue;
          await tx.query('DELETE FROM app_files WHERE key = $1', [fileKey(slot)]);
          slots.delete(slot); delete hashes[slot];
        }
      }
      const missing = Object.entries(LOGO_SLOTS).filter(([slot, spec]) => spec.required && !slots.has(slot)).map(([slot]) => slot);
      if (missing.length) throw fail(400, 'INVALID_LOGO', `The logo is missing its ${missing.join(', ')} image.`);
      await writeMeta(tx, { slots: [...slots], hashes, bg: meta.bg, v: versionOf(slots, hashes, meta.bg) });
      const size = Math.round(Object.values(files).reduce((sum, buffer) => sum + buffer.length, 0) / KB);
      return audit(tx, req.user.id, 'settings.logo-updated', null, `${Object.keys(files).join(', ')} (${size} KB)${dropDark ? ', dark logo removed' : ''}`);
    });
    await reply(res, version);
  });

  app.delete('/api/admin/branding/logo', requireSuper, requireCsrf, async (req, res) => {
    const version = await db.tx(async (tx) => {
      const meta = await readMeta(tx);
      await tx.query('DELETE FROM app_files WHERE key = ANY($1::text[])', [Object.keys(LOGO_SLOTS).map(fileKey)]);
      await writeMeta(tx, { slots: [], hashes: {}, bg: meta.bg, v: versionOf([], {}, meta.bg) });
      return audit(tx, req.user.id, 'settings.logo-updated', null, 'logo removed');
    });
    await reply(res, version);
  });

  app.put('/api/admin/branding/login-image', requireSuper, requireCsrf, express.raw({ type: ['image/jpeg', 'image/webp'], limit: LOGIN_IMAGE_MAX_BYTES }), async (req, res) => {
    const body = req.body;
    const kind = Buffer.isBuffer(body) ? imageKind(body) : null;
    if (!kind || kind !== req.get('content-type')?.split(';')[0].trim()) throw fail(415, 'INVALID_IMAGE', 'Use a JPEG or WebP picture (the settings screen shrinks it for you).');
    const version = await db.tx(async (tx) => {
      const meta = await readMeta(tx);
      await upsertFile(tx, BG_KEY, kind, body, req.user.id);
      const bg = sha(body).slice(0, 16);
      await writeMeta(tx, { ...meta, bg, v: versionOf(meta.slots, meta.hashes, bg) });
      return audit(tx, req.user.id, 'settings.login-image-updated', null, `${Math.round(body.length / KB)} KB`);
    });
    await reply(res, version);
  });

  app.delete('/api/admin/branding/login-image', requireSuper, requireCsrf, async (req, res) => {
    const version = await db.tx(async (tx) => {
      const meta = await readMeta(tx);
      await tx.query('DELETE FROM app_files WHERE key = $1', [BG_KEY]);
      await writeMeta(tx, { ...meta, bg: null, v: versionOf(meta.slots, meta.hashes, null) });
      return audit(tx, req.user.id, 'settings.login-image-updated', null, 'removed');
    });
    await reply(res, version);
  });
}
