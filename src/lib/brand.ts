import type { AppConfig, Branding, HomeConfig, LoginConfig, LogoMeta, LogoSlot } from './types';

export const DEFAULT_BRANDING: Branding = {
  appName: 'GCC Connect', shortName: '', tagline: 'Your office day, sorted.', welcome: '', accent: 'green', theme: null,
  logoHeight: 32, logoAlign: 'left', logoDisplay: 'logo',
};
export const DEFAULT_LOGIN: LoginConfig = {
  title: '', subtitle: '', cardTitle: 'Welcome back', cardText: 'Sign in to {app}.', background: 'gradient', card: 'solid',
  showLogo: true, showTip: false, bullets: ['Real floor plan, live availability', 'One tap to book, one scan to find', 'Events, food, kudos and fun'],
  footerText: '', footerLinks: [], forgotHelp: 'Forgot your password? Ask your workplace team or a super admin to reset it.', usernameHint: '',
};
export const HOME_CARD_IDS = ['hero', 'news', 'stats', 'quick', 'menu', 'whosin', 'celebrate', 'contacts', 'links', 'events', 'tip'] as const;
export const DEFAULT_HOME: HomeConfig = { layout: HOME_CARD_IDS.map((id) => ({ id, on: true })), greeting: '' };
export const NO_LOGO: LogoMeta = { v: '', slots: [], bg: null };

/** Used only when the first settings call fails, so the app can still draw itself and show a retry. */
export const fallbackConfig = (): AppConfig => ({
  features: { links: true, contacts: true, menu: true, announcements: true, issues: true, kudos: false, polls: true, celebrations: true, feedback: true, whosin: true, vibes: true },
  branding: DEFAULT_BRANDING, login: DEFAULT_LOGIN, home: DEFAULT_HOME, logo: NO_LOGO, settings: {},
  options: { showBookerNames: false, eventsRsvpEnabled: true, issuePhotosEnabled: true, homeContacts: true, usageAnalytics: true },
  featureCatalog: {} as AppConfig['featureCatalog'], optionCatalog: {} as AppConfig['optionCatalog'], accents: [],
  menuReviewsVisibility: 'summary', menuHistoryDays: 7, usageRetentionDays: 400, homeContactsCount: 4,
  permissionCatalog: { groups: [], adminDefaults: [] }, notificationCatalog: { channels: [], types: [] },
});

export const logoUrl = (logo: LogoMeta, slot: LogoSlot) => `/api/branding/logo?slot=${slot}&v=${logo.v}`;
export const loginImageUrl = (logo: LogoMeta) => (logo.bg ? `/api/branding/login-image?v=${logo.bg}` : '');
export const hasLogo = (logo: LogoMeta) => logo.slots.includes('header') && logo.slots.includes('login');

import { getLoginTip } from './tips';

/** "Hi {name}" becomes "Hi Ava". {name} is the first name, {fullName} the whole name. */
export function greetingText(template: string, fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? '';
  return template.replace(/\{name\}/gi, first).replace(/\{fullName\}/gi, fullName.trim());
}

export const loginCardText = (text: string, appName: string) => text.replace(/\{app\}/gi, appName);

/** Phase 6 rotating tip for the sign-in page. */
export function loginTip(): string | null {
  return getLoginTip();
}

export function applyBrandingHead(branding: Branding, logo: LogoMeta) {
  document.title = branding.appName;
  const head = document.head;
  const set = (rel: string, href: string, type?: string, sizes?: string) => {
    let link = head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
    if (!link) { link = document.createElement('link'); link.rel = rel; head.appendChild(link); }
    link.href = href;
    if (type) link.type = type; else link.removeAttribute('type');
    if (sizes) link.setAttribute('sizes', sizes); else link.removeAttribute('sizes');
  };
  if (logo.slots.includes('favicon')) {
    set('icon', logoUrl(logo, 'favicon'), 'image/png');
    if (logo.slots.includes('icon192')) set('apple-touch-icon', logoUrl(logo, 'icon192'), undefined, '192x192');
  } else {
    set('icon', '/api/branding/icon.svg', 'image/svg+xml');
  }
}
