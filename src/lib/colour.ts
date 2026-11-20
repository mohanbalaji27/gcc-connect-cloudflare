// Small colour helpers (hex only) used by the theme engine and the contrast checker. No imports, so tests can load it directly.

export type Rgb = [number, number, number];

export function parseHex(input: string): Rgb | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!match) return null;
  let value = match[1];
  if (value.length === 3) value = [...value].map((char) => char + char).join('');
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16)) as Rgb;
}

export const isHex = (input: string) => /^#[0-9a-f]{6}$/i.test(input.trim());
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const channel = (value: number) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0');
export const toHex = ([r, g, b]: Rgb) => `#${channel(r)}${channel(g)}${channel(b)}`;
const must = (hex: string): Rgb => parseHex(hex) ?? [0, 0, 0];

export function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  const [x, y, z] = [r / 255, g / 255, b / 255];
  const max = Math.max(x, y, z);
  const min = Math.min(x, y, z);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === x ? ((y - z) / d) % 6 : max === y ? (z - x) / d + 2 : (x - y) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

export function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

export const hsl = (h: number, s: number, l: number) => toHex(hslToRgb(h, clamp(s), clamp(l)));
export const hslOf = (hex: string) => rgbToHsl(must(hex));

/** amount 0 gives `a`, 1 gives `b`. */
export function mix(a: string, b: string, amount: number): string {
  const [x, y] = [must(a), must(b)];
  return toHex(x.map((value, index) => value + (y[index] - value) * amount) as Rgb);
}

export function luminance(hex: string): number {
  const [r, g, b] = must(hex).map((value) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The ratio rounded down to one decimal, so "4.5" is never shown for 4.46. */
export const ratioText = (ratio: number) => `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`;

/**
 * Moves `fg` towards black or white (whichever direction helps) until it reaches `min` contrast against every background.
 * Returns `fg` unchanged when it already passes.
 */
export function ensureContrast(fg: string, backgrounds: string | string[], min: number): string {
  const list = Array.isArray(backgrounds) ? backgrounds : [backgrounds];
  const worst = (value: string) => Math.min(...list.map((bg) => contrast(value, bg)));
  if (worst(fg) >= min) return fg;
  const average = list.reduce((sum, bg) => sum + luminance(bg), 0) / list.length;
  const target = average > 0.4 ? '#000000' : '#ffffff';
  let best = fg;
  for (let step = 1; step <= 40; step += 1) {
    best = mix(fg, target, step / 40);
    if (worst(best) >= min) return best;
  }
  return best;
}

/** The first candidate that reads on `bg` at `min`, else the better of black and white. */
export function readableOn(bg: string, candidates: string[], min = 4.5): string {
  for (const candidate of candidates) if (contrast(candidate, bg) >= min) return candidate;
  return contrast('#ffffff', bg) >= contrast('#000000', bg) ? '#ffffff' : '#000000';
}
