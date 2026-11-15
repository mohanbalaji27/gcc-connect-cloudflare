export type ThemeMode = 'auto' | 'light' | 'dark';
const MODE_KEY = 'gcc-theme-mode';
const ACCENT_KEY = 'gcc-theme-accent';

export const getMode = (): ThemeMode => (localStorage.getItem(MODE_KEY) as ThemeMode) || 'auto';
export const getAccentChoice = (): string => localStorage.getItem(ACCENT_KEY) || 'default';

export function applyTheme(defaultAccent: string) {
  const mode = getMode();
  const dark = mode === 'dark' || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const choice = getAccentChoice();
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  root.dataset.accent = choice === 'default' ? defaultAccent : choice;
}

export function setMode(mode: ThemeMode, defaultAccent: string) {
  localStorage.setItem(MODE_KEY, mode);
  applyTheme(defaultAccent);
}
export function setAccentChoice(choice: string, defaultAccent: string) {
  localStorage.setItem(ACCENT_KEY, choice);
  applyTheme(defaultAccent);
}
