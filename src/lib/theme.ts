import { contrast, ensureContrast, hsl, hslOf, isHex, mix, parseHex, ratioText, readableOn } from './colour.ts';

// The app-wide colour theme. Only the super admin chooses it (Settings → Appearance); people keep just light / dark / system.
// A theme is a handful of colours; everything else (hover, soft tints, dark mode, readable text colours) is derived here, so
// a custom theme can never produce unreadable text by accident and every screen recolours from CSS variables.

export interface Theme {
  name: string;
  primary: string; primaryStrong: string; accent: string;
  /** A mid-tone whose hue tints the greys, lines and dark-mode surfaces. */
  neutral: string;
  /** Page background in light mode. */
  surface: string;
  ink: string; success: string; warn: string; danger: string;
  /** The preset this theme started from ("reset to preset" goes back to it). */
  base?: string;
}
export type ThemeMode = 'auto' | 'light' | 'dark';

export const PRESETS: Record<string, Theme> = {
  green: { name: 'Forest', primary: '#1f7a56', primaryStrong: '#123d2d', accent: '#d7f35a', neutral: '#52665b', surface: '#f4f6f0', ink: '#14291f', success: '#2f9e6f', warn: '#d9a21b', danger: '#d64545' },
  ocean: { name: 'Ocean', primary: '#1769a8', primaryStrong: '#0d3555', accent: '#8fe3ff', neutral: '#52687a', surface: '#f2f6f9', ink: '#112a3f', success: '#2f9e6f', warn: '#d9a21b', danger: '#d64545' },
  sunset: { name: 'Sunset', primary: '#c44a1d', primaryStrong: '#5a1f0e', accent: '#ffd166', neutral: '#7a665c', surface: '#f8f4f0', ink: '#2b1a14', success: '#2f9e6f', warn: '#d9a21b', danger: '#d64545' },
  berry: { name: 'Berry', primary: '#a62b7a', primaryStrong: '#4a0f38', accent: '#ffb3e0', neutral: '#76596b', surface: '#f8f3f6', ink: '#2a1424', success: '#2f9e6f', warn: '#d9a21b', danger: '#d64545' },
  mono: { name: 'Ink', primary: '#3b4a45', primaryStrong: '#161d1a', accent: '#f1e27c', neutral: '#5b6560', surface: '#f4f5f4', ink: '#161d1a', success: '#2f9e6f', warn: '#d9a21b', danger: '#d64545' },
  // Approximate Zimmer Biomet colours: deep blue family, cool grey and a bright cyan accent. Paste the official hex values to refine.
  zimmer: { name: 'Zimmer Biomet (approximate)', primary: '#0067b1', primaryStrong: '#003c71', accent: '#00a3e0', neutral: '#6c7a89', surface: '#f3f6fa', ink: '#0f2a43', success: '#2f9e6f', warn: '#d9a21b', danger: '#d64545' },
};
for (const [id, theme] of Object.entries(PRESETS)) theme.base = id;
export const PRESET_IDS = Object.keys(PRESETS);
export const DEFAULT_PRESET = 'green';

export interface BrandingTheme { accent: string; theme?: Theme | null }
export function resolveTheme(branding: BrandingTheme | undefined): Theme {
  if (branding?.accent === 'custom' && branding.theme) return branding.theme;
  return PRESETS[branding?.accent ?? DEFAULT_PRESET] ?? PRESETS[DEFAULT_PRESET];
}

/** A darker companion for a main colour: used when someone picks only a primary colour. */
export function suggestStrong(primary: string): string {
  const [h, s, l] = hslOf(primary);
  return hsl(h, Math.min(1, s * 0.95), Math.max(0.1, l * 0.45));
}

type Vars = Record<string, string>;
export interface Derived { light: Vars; dark: Vars }

const WHITE = '#ffffff';
const BLACK = '#000000';
const rgbTriplet = (hex: string) => (parseHex(hex) ?? [0, 0, 0]).join(' ');
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function semantic(vars: Vars, name: string, base: string, soft: string, mode: 'light' | 'dark', card: string) {
  vars[`--${name}`] = base;
  vars[`--${name}-soft`] = soft;
  vars[`--${name}-line`] = mode === 'light' ? mix(base, WHITE, 0.72) : mix(card, base, 0.5);
  vars[`--${name}-ink`] = ensureContrast(mode === 'light' ? mix(base, BLACK, 0.4) : mix(base, WHITE, 0.45), soft, mode === 'light' ? 5 : 6);
}

export function deriveTheme(theme: Theme): Derived {
  const [hue, neutralSat] = hslOf(theme.neutral);
  const sd = clamp(neutralSat * 1.9, 0.1, 0.28);

  // ----- dark surfaces (tinted with the neutral's hue) -----
  const dBg = hsl(hue, sd, 0.075);
  const dCard = hsl(hue, sd, 0.115);
  const dTint = hsl(hue, sd, 0.165);
  const dTint2 = hsl(hue, sd, 0.14);
  const dTintStrong = hsl(hue, sd, 0.235);
  const dInset = hsl(hue, sd, 0.085);
  const dLine = hsl(hue, sd, 0.19);
  const dLineStrong = hsl(hue, sd, 0.235);
  const dInk = hsl(hue, sd * 0.9, 0.93);
  const dSoft = ensureContrast(hsl(hue, sd * 0.5, 0.79), [dCard, dTint], 7);
  const dFaint = ensureContrast(hsl(hue, sd * 0.4, 0.66), [dCard, dTint, dTintStrong], 4.5);

  const shared = (): Vars => ({
    '--primary': theme.primary, '--primary-strong': theme.primaryStrong, '--accent': theme.accent,
    '--on-primary': WHITE, '--accent-deep': mix(theme.accent, BLACK, 0.15),
    '--on-accent': readableOn(theme.accent, [theme.primaryStrong, theme.ink, BLACK, WHITE]),
    '--primary-hover': ensureContrast(mix(theme.primary, BLACK, 0.16), WHITE, 4.5),
    '--grad-brand': `linear-gradient(135deg, ${theme.primaryStrong}, ${theme.primary})`,
    '--grad-brand-soft': `linear-gradient(150deg, ${theme.primaryStrong}, ${theme.primary})`,
    '--hero-text': WHITE,
    '--hero-text-2': ensureContrast(mix(WHITE, theme.primaryStrong, 0.18), [theme.primary, theme.primaryStrong], 4.5),
    '--hero-text-3': ensureContrast(mix(WHITE, theme.primaryStrong, 0.3), [theme.primary, theme.primaryStrong], 4.5),
    '--bar-muted': ensureContrast(mix(WHITE, theme.primaryStrong, 0.35), theme.primaryStrong, 4.5),
    '--accent-bright': ensureContrast(theme.accent, [theme.primaryStrong, dCard], 4.5),
  });

  // ----- light -----
  const bg = theme.surface;
  const ink = theme.ink;
  const tint = mix(bg, ink, 0.045);
  const tintStrong = mix(bg, ink, 0.09);
  const light: Vars = {
    ...shared(),
    '--bg': bg, '--card': WHITE, '--ink': ink,
    '--ink-soft': ensureContrast(mix(ink, WHITE, 0.3), [bg, tint], 5.5),
    '--ink-faint': ensureContrast(mix(ink, WHITE, 0.46), [bg, tint, tintStrong], 4.5),
    '--line': mix(bg, ink, 0.09), '--line-strong': mix(bg, ink, 0.2),
    '--tint': tint, '--tint-2': mix(bg, WHITE, 0.55), '--tint-strong': tintStrong, '--inset': WHITE,
    '--primary-soft': mix(theme.primary, WHITE, 0.9), '--primary-line': mix(theme.primary, WHITE, 0.7),
    '--primary-ink': ensureContrast(theme.primary, [WHITE, bg], 4.5),
    '--accent-ink': ensureContrast(theme.accent, [WHITE, bg], 4.5),
    '--shadow-rgb': rgbTriplet(ink),
  };
  semantic(light, 'success', theme.success, mix(theme.success, WHITE, 0.88), 'light', WHITE);
  semantic(light, 'warn', theme.warn, mix(theme.warn, WHITE, 0.86), 'light', WHITE);
  semantic(light, 'danger', theme.danger, mix(theme.danger, WHITE, 0.9), 'light', WHITE);

  // ----- dark -----
  const dark: Vars = {
    ...shared(),
    '--bg': dBg, '--card': dCard, '--ink': dInk, '--ink-soft': dSoft, '--ink-faint': dFaint,
    '--line': dLine, '--line-strong': dLineStrong,
    '--tint': dTint, '--tint-2': dTint2, '--tint-strong': dTintStrong, '--inset': dInset,
    '--primary-soft': mix(dCard, theme.primary, 0.22), '--primary-line': mix(dCard, theme.primary, 0.5),
    '--primary-ink': ensureContrast(mix(theme.primary, WHITE, 0.35), [dCard, mix(dCard, theme.primary, 0.22)], 4.5),
    '--accent-ink': ensureContrast(theme.accent, [dCard, dTint], 4.5),
    '--shadow-rgb': '0 0 0',
  };
  semantic(dark, 'success', theme.success, mix(dCard, theme.success, 0.28), 'dark', dCard);
  semantic(dark, 'warn', theme.warn, mix(dCard, theme.warn, 0.28), 'dark', dCard);
  semantic(dark, 'danger', theme.danger, mix(dCard, theme.danger, 0.3), 'dark', dCard);
  return { light, dark };
}

const block = (selector: string, vars: Vars) => `${selector}{${Object.entries(vars).map(([key, value]) => `${key}:${value}`).join(';')}}`;
export const themeCss = (theme: Theme): string => {
  const { light, dark } = deriveTheme(theme);
  // html:root outranks the plain :root defaults in styles.css wherever the stylesheet ends up in the page.
  return `${block('html:root', light)}\n${block('html:root[data-theme="dark"]', dark)}`;
};

// ---------- contrast checks (WCAG 2.x AA) ----------
export interface ContrastCheck {
  id: string; label: string; fg: string; bg: string; ratio: number; min: number; pass: boolean;
  /** A failing blocking check stops the theme from being saved. */
  blocking: boolean; hint: string;
}

export function themeChecks(theme: Theme): ContrastCheck[] {
  const { light, dark } = deriveTheme(theme);
  const check = (id: string, label: string, fg: string, bg: string, min: number, blocking: boolean, hint: string): ContrastCheck => {
    const ratio = contrast(fg, bg);
    return { id, label, fg, bg, ratio, min, pass: ratio >= min, blocking, hint };
  };
  return [
    check('button', 'Button labels (white on the main colour)', WHITE, theme.primary, 4.5, true, 'Make the main colour darker so white button text is readable.'),
    check('bar', 'Top bar and menu text (white on the strong colour)', WHITE, theme.primaryStrong, 4.5, true, 'Make the strong colour darker.'),
    check('body', 'Body text on the page background', theme.ink, theme.surface, 4.5, true, 'Use a darker text colour or a lighter page background.'),
    check('links', 'Links and highlights in the main colour on white', theme.primary, WHITE, 4.5, true, 'Make the main colour darker.'),
    check('accent-label', 'Text on accent buttons', light['--on-accent'], theme.accent, 4.5, false, 'Choose an accent that is clearly lighter or darker than its text.'),
    check('accent-bar', 'Accent text on the top bar (adjusted automatically)', light['--accent-bright'], theme.primaryStrong, 4.5, false, 'The accent is lightened a little where it sits on dark bars.'),
    check('dark-body', 'Dark mode: body text on cards', dark['--ink'], dark['--card'], 4.5, false, 'Dark mode colours are derived automatically.'),
    check('dark-links', 'Dark mode: links on cards', dark['--primary-ink'], dark['--card'], 4.5, false, 'Dark mode colours are derived automatically.'),
    check('dark-ui', 'Dark mode: main colour against cards (buttons, switches)', theme.primary, dark['--card'], 3, false, 'A very dark main colour can disappear on dark cards. Lighten it a little.'),
    check('ok', 'Success labels', light['--success-ink'], light['--success-soft'], 4.5, false, 'Derived automatically.'),
    check('warn', 'Warning labels', light['--warn-ink'], light['--warn-soft'], 4.5, false, 'Derived automatically.'),
    check('danger', 'Error labels', light['--danger-ink'], light['--danger-soft'], 4.5, false, 'Derived automatically.'),
  ];
}
export const themeBlockers = (theme: Theme) => themeChecks(theme).filter((item) => item.blocking && !item.pass);

export function themeProblem(theme: Theme): string | null {
  for (const field of ['primary', 'primaryStrong', 'accent', 'neutral', 'surface', 'ink', 'success', 'warn', 'danger'] as const) {
    if (!isHex(theme[field])) return `Enter ${field} as a colour like #0067b1.`;
  }
  const blocker = themeBlockers(theme)[0];
  return blocker ? `${blocker.label}: ${ratioText(blocker.ratio)}, needs ${blocker.min}:1. ${blocker.hint}` : null;
}

// ---------- applying a theme ----------
const MODE_KEY = 'gcc-theme-mode';
const CSS_KEY = 'gcc-theme-css';
const BAR_KEY = 'gcc-theme-bar';
export const getMode = (): ThemeMode => {
  const stored = localStorage.getItem(MODE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'auto';
};

export function applyMode() {
  const mode = getMode();
  const dark = mode === 'dark' || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
export function setMode(mode: ThemeMode) {
  localStorage.setItem(MODE_KEY, mode);
  applyMode();
}

function styleTag(): HTMLStyleElement {
  let tag = document.getElementById('gcc-theme') as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement('style');
    tag.id = 'gcc-theme';
    document.head.appendChild(tag);
  }
  return tag;
}
function barColour(color: string) {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) { meta = document.createElement('meta'); meta.name = 'theme-color'; document.head.appendChild(meta); }
  meta.content = color;
}

/** Writes the theme into the page. Remembered locally so the next visit paints in the right colours straight away. */
export function applyThemeColours(theme: Theme) {
  const css = themeCss(theme);
  styleTag().textContent = css;
  barColour(theme.primaryStrong);
  try { localStorage.setItem(CSS_KEY, css); localStorage.setItem(BAR_KEY, theme.primaryStrong); } catch { /* private mode */ }
}
export function applyRememberedTheme() {
  applyMode();
  try {
    const css = localStorage.getItem(CSS_KEY);
    if (css) { styleTag().textContent = css; barColour(localStorage.getItem(BAR_KEY) ?? '#123d2d'); return; }
  } catch { /* ignore */ }
  styleTag().textContent = themeCss(PRESETS[DEFAULT_PRESET]);
  barColour(PRESETS[DEFAULT_PRESET].primaryStrong);
}
