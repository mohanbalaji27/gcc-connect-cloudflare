import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppConfig, Bootstrap, Branding, FeatureKey, HomeContact, LoginConfig, LogoMeta, MapInfo, PublicConfig, Summary, Team, User } from '../lib/types';
import { api, ApiError, messageOf, onConfigVersion, setCsrf } from '../lib/api';
import { startPulse } from '../lib/pulse';
import { resetUsage, setUsageEnabled, startUsage, track, type UsageFeature } from '../lib/usage';
import { clearAvailability } from '../lib/availability';
import { clearResources } from '../lib/resources';
import { clearMenu } from '../lib/menuData';
import { applyMode, applyThemeColours, resolveTheme } from '../lib/theme';
import { DEFAULT_BRANDING, DEFAULT_LOGIN, NO_LOGO, applyBrandingHead, fallbackConfig } from '../lib/brand';
import { BrandMark } from './Brand';
import { LoginScreen } from './Login';
import { nav as navHandoff } from '../lib/nav';
import { reloadFloorPlan, resetFloorPlan, type FloorPlanImage } from '../lib/floorplan';
import { Avatar, Icon, KitProvider, Spinner, useKit } from './kit';
import { HomeScreen } from './screens/Home';
import { BookScreen } from './screens/Book';
import { BookingsScreen } from './screens/Bookings';
import { EventsScreen } from './screens/Events';
import { ScanScreen } from './screens/Scan';
import { ManageScreen, manageTabs } from './screens/Manage';
import { AccountScreen } from './screens/Account';
import { MenuScreen } from './screens/Menu';
import { CommunityScreen } from './screens/Community';
import { UsefulScreen } from './screens/Useful';
import { MoreScreen } from './screens/More';
import { IssuesScreen, type IssueFocus } from './screens/Issues';
import { StaffHome } from './screens/StaffHome';
import { NotificationBell, NotificationSheet } from './Notifications';
import './issues.css';
import './analytics.css';

export type Screen = 'home' | 'book' | 'bookings' | 'events' | 'scan' | 'manage' | 'account' | 'menu' | 'community' | 'useful' | 'more' | 'issues';
export type NavItem = [Screen, string, string];
export interface QrIntent { resourceId: string; token?: string; stay?: string; report?: boolean }
const PUBLIC_KEY = 'gcc-public-config';
// The sign-in page paints from the last copy of the public settings straight away, then checks for a newer one.
const rememberedPublic = (): Partial<PublicConfig> => { try { return JSON.parse(localStorage.getItem(PUBLIC_KEY) ?? '{}') as Partial<PublicConfig>; } catch { return {}; } };
// Screens that count as one feature each. Community and Useful stuff count per tab instead (kudos, polls, links, contacts...).
const SCREEN_FEATURE: Partial<Record<Screen, UsageFeature>> = { home: 'home', book: 'booking', bookings: 'my_bookings', events: 'events', scan: 'scan', menu: 'menu', issues: 'issues', account: 'account', manage: 'manage', more: 'more' };

export interface Ctx {
  user: User;
  config: AppConfig;
  /** Changes whenever an admin edits settings, teams, spaces or the map (see GET /api/pulse). */
  configVersion: number;
  flag: (key: FeatureKey) => boolean;
  reloadConfig: () => Promise<void>;
  getSummary: () => Promise<Summary>;
  invalidateSummary: () => void;
  updateUser: (user: User) => void;
  plan: FloorPlanImage | null;
  planLoading: boolean;
  teams: Team[];
  unassignedSeats: number;
  mapInfo: MapInfo | null;
  /** The few contacts the Home card shows (already part of the bootstrap, so Home makes no request for them). */
  homeContacts: HomeContact[];
  reloadTeams: () => Promise<void>;
  reloadMap: () => Promise<void>;
  reloadPlan: () => Promise<void>;
  go: (screen: Screen) => void;
  startBooking: (intent: QrIntent | { kind: 'desk' | 'room' }) => void;
  /** Opens one issue (from a notification, a task card or a link). */
  openIssue: (id: string) => void;
}

function Shell() {
  const { toast } = useKit();
  const [user, setUser] = useState<User | null>(null);
  const [booting, setBooting] = useState(true);
  const [screen, setScreen] = useState<Screen>('home');
  const [plan, setPlan] = useState<FloorPlanImage | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [teams, setTeams] = useState<Team[]>([]);
  const [unassignedSeats, setUnassignedSeats] = useState(0);
  const [mapInfo, setMapInfo] = useState<MapInfo | null>(null);
  const [intent, setIntent] = useState<QrIntent | { kind: 'desk' | 'room' } | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [updateReady, setUpdateReady] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [branding, setBranding] = useState<Branding>(() => ({ ...DEFAULT_BRANDING, ...rememberedPublic().branding }));
  const [loginConfig, setLoginConfig] = useState<LoginConfig>(() => ({ ...DEFAULT_LOGIN, ...rememberedPublic().login }));
  const [logo, setLogo] = useState<LogoMeta>(() => ({ ...NO_LOGO, ...rememberedPublic().logo }));
  const [minLength, setMinLength] = useState<number>(() => rememberedPublic().passwordMinLength ?? 10);
  const [configVersion, setConfigVersion] = useState(0);
  const [unread, setUnread] = useState(0);
  const [homeContacts, setHomeContacts] = useState<HomeContact[]>([]);
  const [bellOpen, setBellOpen] = useState(false);
  const [issueFocus, setIssueFocus] = useState<IssueFocus | null>(null);
  const knownVersion = useRef(0);
  const loadingBootstrap = useRef<Promise<void> | null>(null);
  const planVersion = useRef<number | null>(null);
  const slices = useRef<Record<string, string>>({});
  const summaryCache = useRef<{ value: Summary; at: number } | null>(null);

  const reloadPlan = useCallback(async () => {
    setPlanLoading(true);
    try { setPlan(await reloadFloorPlan()); } finally { setPlanLoading(false); }
  }, []);

  // Each part of the bootstrap only replaces its state when it really changed, so a routine refresh does not re-render
  // (or re-fetch) screens that have nothing new to show.
  const applyBootstrap = useCallback((boot: Bootstrap) => {
    const slice = <T,>(key: string, value: T, set: (next: T) => void) => {
      const raw = JSON.stringify(value);
      if (slices.current[key] === raw) return;
      slices.current[key] = raw;
      set(value);
    };
    knownVersion.current = boot.configVersion;
    setConfigVersion(boot.configVersion);
    slice('user', boot.user, setUser);
    slice('config', boot.config, (next) => { setConfig(next); setBranding(next.branding); setLoginConfig(next.login); setLogo(next.logo); clearMenu(); });
    slice('teams', { teams: boot.teams, unassigned: boot.unassignedSeats }, (next) => { setTeams(next.teams); setUnassignedSeats(next.unassigned); });
    slice('map', boot.map, setMapInfo);
    slice('homeContacts', boot.homeContacts ?? [], setHomeContacts);
    summaryCache.current = { value: boot.summary, at: Date.now() };
    setUnread(boot.unread ?? 0);
    if (boot.map.floorPlanAvailable && planVersion.current !== boot.map.floorPlanVersion) {
      planVersion.current = boot.map.floorPlanVersion;
      void reloadPlan();
    }
  }, [reloadPlan]);

  // One call brings settings, teams, map info and the summary. Calls made while one is running share its result.
  const reloadBootstrap = useCallback((): Promise<void> => {
    if (loadingBootstrap.current) return loadingBootstrap.current;
    const run = api<Bootstrap>('/bootstrap').then(applyBootstrap).finally(() => { loadingBootstrap.current = null; });
    loadingBootstrap.current = run;
    return run;
  }, [applyBootstrap]);

  const getSummary = useCallback(async () => {
    const cached = summaryCache.current;
    if (cached && Date.now() - cached.at < 120_000) return cached.value;
    const value = await api<Summary>('/me/summary');
    summaryCache.current = { value, at: Date.now() };
    return value;
  }, []);
  const invalidateSummary = useCallback(() => { if (summaryCache.current) summaryCache.current.at = 0; }, []);

  useEffect(() => {
    api<{ user: User | null; csrfToken?: string }>('/session')
      .then((session) => { setCsrf(session.csrfToken ?? ''); setUser(session.user); })
      .catch(() => setUser(null))
      .finally(() => setBooting(false));
    api<PublicConfig>('/public-config').then((result) => {
      setBranding(result.branding); setLoginConfig(result.login); setLogo(result.logo); setMinLength(result.passwordMinLength);
      try { localStorage.setItem(PUBLIC_KEY, JSON.stringify(result)); } catch { /* private mode */ }
    }).catch(() => {});
  }, []);

  // The colours belong to the super admin's theme; people only choose light, dark or follow their device.
  const theme = useMemo(() => resolveTheme(branding), [branding]);
  useEffect(() => { applyThemeColours(theme); }, [theme]);
  useEffect(() => { applyBrandingHead(branding, logo); }, [branding, logo]);
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', applyMode);
    return () => query.removeEventListener('change', applyMode);
  }, []);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return;
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) setUpdateReady(true); });
      });
    }).catch(() => {});
  }, []);

  const ready = Boolean(user && !user.mustChangePassword);
  useEffect(() => {
    if (!ready) return undefined;
    void reloadBootstrap().catch(() => {
      setConfig((current) => current ?? fallbackConfig());
    });
    // Any response that reports a newer settings version, and the periodic pulse, both end up here.
    const noticed = (version: number) => { if (knownVersion.current > 0 && version !== knownVersion.current) void reloadBootstrap().catch(() => {}); };
    onConfigVersion(noticed);
    // The bell's unread count rides on the pulse that is already running: no extra request.
    const stopPulse = startPulse({ onPulse: (reply) => {
      noticed(reply.configVersion);
      const count = (reply.notifications as { unread?: number } | undefined)?.unread;
      if (typeof count === 'number') setUnread(count);
    } });
    return () => { onConfigVersion(null); stopPulse(); };
  }, [ready, reloadBootstrap]);

  // Usage analytics (counts of screens opened, see lib/usage.ts): on only while the super admin keeps it switched on.
  const usageOn = ready && config !== null && config.options.usageAnalytics !== false;
  useEffect(() => { setUsageEnabled(usageOn); }, [usageOn]);
  useEffect(() => (usageOn ? startUsage() : undefined), [usageOn]);
  useEffect(() => { const feature = SCREEN_FEATURE[screen]; if (usageOn && feature) track(feature); }, [screen, usageOn]);

  const resetSession = useCallback(() => {
    setCsrf('');
    resetFloorPlan();
    clearAvailability();
    clearResources();
    clearMenu();
    slices.current = {};
    knownVersion.current = 0;
    planVersion.current = null;
    summaryCache.current = null;
    setPlan(null);
    setTeams([]);
    setConfig(null);
    setConfigVersion(0);
    setUnread(0);
    setHomeContacts([]);
    resetUsage();
    setBellOpen(false);
    setUser(null);
  }, []);

  useEffect(() => {
    const expired = () => { resetSession(); toast('Your session ended. Please sign in again.', 'info'); };
    window.addEventListener('gcc-auth-expired', expired);
    return () => window.removeEventListener('gcc-auth-expired', expired);
  }, [toast, resetSession]);

  const handleQrParams = useCallback(async () => {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    const resourceId = params.get('resource');
    const reportId = params.get('report');
    const stay = params.get('stay') ?? undefined;
    if (!token && !resourceId && !reportId) return;
    history.replaceState(null, '', location.pathname);
    // A "report a problem" sticker (?report=<seat or room>) opens the issue form already pointing at that place.
    if (reportId) { setIssueFocus({ resourceId: reportId }); setScreen('issues'); return; }
    if (resourceId) { setIntent({ resourceId, token: token ?? undefined, stay }); setScreen('book'); }
    else toast('That booking QR is missing its space. Ask an admin for a new one.', 'error');
  }, [toast]);

  useEffect(() => { if (ready) void handleQrParams(); }, [ready, handleQrParams]);

  const go = useCallback((next: Screen) => { setScreen(next); window.scrollTo({ top: 0, behavior: 'smooth' }); }, []);
  const clearIntent = useCallback(() => setIntent(null), []);
  const clearIssueFocus = useCallback(() => setIssueFocus(null), []);
  const openBell = useCallback(() => { track('notifications'); setBellOpen(true); }, []);
  const startBooking = useCallback((next: QrIntent | { kind: 'desk' | 'room' }) => { setIntent(next); setScreen('book'); window.scrollTo({ top: 0 }); }, []);
  const openIssue = useCallback((id: string) => { setIssueFocus({ issueId: id }); setScreen('issues'); window.scrollTo({ top: 0 }); }, []);
  const openNotificationLink = useCallback((link: string) => {
    if (link.startsWith('issue:')) return openIssue(link.slice(6));
    if (link === 'issues') return go('issues');
    if (link === 'ideas') { navHandoff.manageTab = 'community'; return go('manage'); }
    return go('home');
  }, [openIssue, go]);

  async function signOut() {
    try { await api('/logout', { method: 'POST' }); } catch (reason) { if (!(reason instanceof ApiError) || reason.status !== 401) toast(messageOf(reason), 'error'); }
    resetSession();
    setScreen('home');
  }

  const ctx: Ctx | null = useMemo(
    () => (user && ready && config
      ? { user, config, configVersion, flag: (key: FeatureKey) => config.features[key] !== false, reloadConfig: reloadBootstrap, getSummary, invalidateSummary, updateUser: setUser, plan, planLoading, teams, unassignedSeats, mapInfo, reloadTeams: reloadBootstrap, reloadMap: reloadBootstrap, reloadPlan, go, startBooking, openIssue, homeContacts }
      : null),
    [user, ready, config, configVersion, plan, planLoading, teams, unassignedSeats, mapInfo, reloadBootstrap, getSummary, invalidateSummary, reloadPlan, go, startBooking, openIssue, homeContacts],
  );

  if (booting) return <div className="boot"><Spinner label="Warming up" /></div>;
  if (!user) return <LoginScreen branding={branding} login={loginConfig} logo={logo} onSignedIn={(next) => setUser(next)} />;
  if (user.mustChangePassword) return <AccountScreen user={user} forced minLength={minLength} onChanged={() => setUser({ ...user, mustChangePassword: false })} onSignOut={signOut} />;
  if (!ctx) return <div className="boot"><Spinner label="Getting things ready" /></div>;

  const manager = manageTabs(user).length > 0;
  const flag = ctx.flag;
  const hasCommunity = flag('kudos') || flag('polls') || flag('celebrations') || flag('feedback');
  const hasUseful = flag('links') || flag('contacts');
  const hasIssues = flag('issues');
  // Hands-on teams get a short list: their tasks, reporting, scanning, contacts and the menu.
  const simple = user.simpleUi;
  const nav: NavItem[] = simple ? [
    ['home', 'Home', 'tasks'],
    ...(hasIssues ? [['issues', 'Tasks and reports', 'wrench'] as NavItem] : []),
    ['scan', 'Scan QR', 'scan'],
    ...(hasUseful ? [['useful', 'Contacts', 'phone'] as NavItem] : []),
    ...(flag('menu') ? [['menu', 'Food menu', 'utensils'] as NavItem] : []),
  ] : [
    ['home', 'Home', 'home'], ['book', 'Book', 'desk'], ['bookings', 'My bookings', 'ticket'], ['events', 'Events', 'party'],
    ...(hasIssues ? [['issues', 'Report a problem', 'wrench'] as NavItem] : []),
    ...(flag('menu') ? [['menu', 'Food menu', 'utensils'] as NavItem] : []),
    ...(hasCommunity ? [['community', 'Community', 'heart'] as NavItem] : []),
    ...(hasUseful ? [['useful', 'Useful stuff', 'link'] as NavItem] : []),
    ['scan', 'Scan QR', 'scan'],
    ...(manager ? [['manage', 'Manage', 'shield'] as NavItem] : []),
  ];
  const mobileNav: NavItem[] = simple ? ([
    ['home', 'Home', 'tasks'], ...(hasIssues ? [['issues', 'Report', 'wrench'] as NavItem] : []), ['scan', 'Scan', 'scan'],
    ...(hasUseful ? [['useful', 'Contacts', 'phone'] as NavItem] : []), ...(flag('menu') ? [['menu', 'Menu', 'utensils'] as NavItem] : []),
  ] as NavItem[]).slice(0, 5) : [
    ['home', 'Home', 'home'], ['book', 'Book', 'desk'], ['events', 'Events', 'party'],
    hasIssues ? ['issues', 'Report', 'wrench'] : hasCommunity ? ['community', 'Community', 'heart'] : ['bookings', 'Trips', 'ticket'], ['more', 'More', 'grid'],
  ];
  const allowed = (id: Screen) => id === 'account' || id === 'more' || nav.some(([item]) => item === id);
  const roleLabel = user.role === 'super_admin' ? 'Super admin' : user.roleName ?? (user.role === 'admin' ? 'Admin' : user.team || 'Employee');
  const mobileActive = (id: Screen) => screen === id || (id === 'more' && !mobileNav.some(([m]) => m === screen));

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand" data-align={branding.logoAlign}><BrandMark branding={branding} logo={logo} place="bar" /></div>
          <NotificationBell unread={unread} onClick={openBell} />
        </div>
        <nav aria-label="Primary">
          {nav.map(([id, label, icon]) => (
            <button key={id} className={`nav-item ${screen === id ? 'active' : ''}`} onClick={() => go(id)} aria-current={screen === id ? 'page' : undefined}>
              <Icon name={icon} size={20} /><span>{label}</span>
            </button>
          ))}
        </nav>
        <button className="profile-card" onClick={() => go('account')} aria-label="Account settings">
          <Avatar name={user.name} emoji={user.avatar} />
          <span><strong>{user.name}</strong><small>{roleLabel}</small></span>
        </button>
        <button className="nav-item signout" onClick={() => void signOut()}><Icon name="logout" size={20} /><span>Sign out</span></button>
      </aside>
      <div className="content-column">
        <header className="topbar">
          <div className="brand compact" data-align={branding.logoAlign}><BrandMark branding={branding} logo={logo} place="bar" height={Math.min(branding.logoHeight, 32)} /></div>
          <div className="topbar-right">
            {!online && <span className="pill pill-warn">Offline</span>}
            <NotificationBell unread={unread} onClick={openBell} />
            <button className="icon-avatar" onClick={() => go('account')} aria-label="Account settings"><Avatar name={user.name} emoji={user.avatar} size={36} /></button>
          </div>
        </header>
        {(!online || updateReady) && (
          <div className="banner" role="status">
            {!online ? 'You are offline. You can browse, but bookings need a connection.' : `A fresh version of ${branding.appName} is ready.`}
            {updateReady && <button className="button button-small" onClick={() => location.reload()}>Refresh</button>}
          </div>
        )}
        <main id="main" key={screen} className="screen">
          {screen === 'home' && (simple ? <StaffHome ctx={ctx} /> : <HomeScreen ctx={ctx} />)}
          {screen === 'issues' && hasIssues && allowed('issues') && <IssuesScreen ctx={ctx} focus={issueFocus} clearFocus={clearIssueFocus} />}
          {screen === 'book' && !simple && <BookScreen ctx={ctx} intent={intent} clearIntent={clearIntent} online={online} />}
          {screen === 'bookings' && !simple && <BookingsScreen ctx={ctx} />}
          {screen === 'events' && !simple && <EventsScreen ctx={ctx} />}
          {screen === 'scan' && <ScanScreen ctx={ctx} onResolved={(next) => {
            if (next.report) { setIssueFocus({ resourceId: next.resourceId }); setScreen('issues'); return; }
            if (simple) { toast('Use “Report a problem” for this sticker.', 'info'); return; }
            setIntent(next); setScreen('book');
          }} />}
          {screen === 'menu' && flag('menu') && <MenuScreen ctx={ctx} />}
          {screen === 'community' && hasCommunity && !simple && <CommunityScreen ctx={ctx} />}
          {screen === 'useful' && hasUseful && <UsefulScreen ctx={ctx} />}
          {screen === 'more' && !simple && <MoreScreen ctx={ctx} items={nav.filter(([id]) => id !== 'home')} onSignOut={signOut} />}
          {screen === 'manage' && manager && !simple && <ManageScreen ctx={ctx} />}
          {screen === 'account' && <AccountScreen ctx={ctx} onChanged={() => toast('Password updated. Nicely done.', 'success')} onSignOut={signOut} />}
        </main>
      </div>
      {bellOpen && <NotificationSheet onClose={() => setBellOpen(false)} onOpenLink={openNotificationLink} onUnread={setUnread} onSettings={() => go('account')} />}
      <nav className="bottom-nav" aria-label="Primary mobile">
        {mobileNav.map(([id, label, icon]) => (
          <button key={id} className={`bottom-item ${mobileActive(id) ? 'active' : ''}`} onClick={() => go(id)} aria-current={screen === id ? 'page' : undefined}>
            <Icon name={icon} size={22} /><span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

export default function App() {
  return <KitProvider><Shell /></KitProvider>;
}
