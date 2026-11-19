import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppConfig, Bootstrap, Branding, FeatureKey, MapInfo, Summary, Team, User } from '../lib/types';
import { api, ApiError, messageOf, onConfigVersion, setCsrf } from '../lib/api';
import { startPulse } from '../lib/pulse';
import { clearAvailability } from '../lib/availability';
import { clearResources } from '../lib/resources';
import { clearMenu } from '../lib/menuData';
import { applyTheme } from '../lib/theme';
import { nav as navHandoff } from '../lib/nav';
import { reloadFloorPlan, resetFloorPlan, type FloorPlanImage } from '../lib/floorplan';
import { Avatar, Icon, KitProvider, Spinner, useKit, Field } from './kit';
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

export type Screen = 'home' | 'book' | 'bookings' | 'events' | 'scan' | 'manage' | 'account' | 'menu' | 'community' | 'useful' | 'more' | 'issues';
export type NavItem = [Screen, string, string];
export interface QrIntent { resourceId: string; token?: string; stay?: string; report?: boolean }
const DEFAULT_BRANDING: Branding = { appName: 'GCC Connect', tagline: 'Your office day, sorted.', accent: 'green', welcome: '' };

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
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);
  const [configVersion, setConfigVersion] = useState(0);
  const [unread, setUnread] = useState(0);
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
    slice('config', boot.config, (next) => { setConfig(next); setBranding(next.branding); clearMenu(); });
    slice('teams', { teams: boot.teams, unassigned: boot.unassignedSeats }, (next) => { setTeams(next.teams); setUnassignedSeats(next.unassigned); });
    slice('map', boot.map, setMapInfo);
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
    api<{ branding: Branding }>('/public-config').then((result) => setBranding(result.branding)).catch(() => {});
  }, []);

  useEffect(() => {
    applyTheme(branding.accent);
    document.title = branding.appName;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => applyTheme(branding.accent);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  }, [branding]);

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
      setConfig((current) => current ?? { features: { links: true, contacts: true, menu: true, announcements: true, issues: true, kudos: false, polls: true, celebrations: true, feedback: true, whosin: true, vibes: true }, branding: DEFAULT_BRANDING, options: { showBookerNames: false, eventsRsvpEnabled: true, issuePhotosEnabled: true }, featureCatalog: {} as AppConfig['featureCatalog'], optionCatalog: {} as AppConfig['optionCatalog'], accents: ['green', 'ocean', 'sunset', 'berry', 'mono'], menuReviewsVisibility: 'summary', menuHistoryDays: 7, permissionCatalog: { groups: [], adminDefaults: [] }, notificationCatalog: { channels: [], types: [] } });
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
      ? { user, config, configVersion, flag: (key: FeatureKey) => config.features[key] !== false, reloadConfig: reloadBootstrap, getSummary, invalidateSummary, updateUser: setUser, plan, planLoading, teams, unassignedSeats, mapInfo, reloadTeams: reloadBootstrap, reloadMap: reloadBootstrap, reloadPlan, go, startBooking, openIssue }
      : null),
    [user, ready, config, configVersion, plan, planLoading, teams, unassignedSeats, mapInfo, reloadBootstrap, getSummary, invalidateSummary, reloadPlan, go, startBooking, openIssue],
  );

  if (booting) return <div className="boot"><Spinner label="Warming up" /></div>;
  if (!user) return <LoginScreen branding={branding} onSignedIn={(next) => setUser(next)} />;
  if (user.mustChangePassword) return <AccountScreen user={user} forced onChanged={() => setUser({ ...user, mustChangePassword: false })} onSignOut={signOut} />;
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
  const brandParts = branding.appName.trim().split(' ');
  const brandLast = brandParts.length > 1 ? brandParts.pop() : '';
  const brand = <span>{brandParts.join(' ')}{brandLast ? <> <b>{brandLast}</b></> : null}</span>;
  const roleLabel = user.role === 'super_admin' ? 'Super admin' : user.roleName ?? (user.role === 'admin' ? 'Admin' : user.team || 'Employee');
  const mobileActive = (id: Screen) => screen === id || (id === 'more' && !mobileNav.some(([m]) => m === screen));

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand"><span className="brand-mark"><Icon name="sparkle" size={20} /></span>{brand}</div>
          <NotificationBell unread={unread} onClick={() => setBellOpen(true)} />
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
          <div className="brand compact"><span className="brand-mark"><Icon name="sparkle" size={18} /></span>{brand}</div>
          <div className="topbar-right">
            {!online && <span className="pill pill-warn">Offline</span>}
            <NotificationBell unread={unread} onClick={() => setBellOpen(true)} />
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

function LoginScreen({ branding, onSignedIn }: { branding: Branding; onSignedIn: (user: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const demo = import.meta.env.DEV;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ user: User; csrfToken: string }>('/login', { method: 'POST', body: { login: email.trim(), password } });
      setCsrf(result.csrfToken);
      onSignedIn(result.user);
    } catch (reason) {
      setError(messageOf(reason));
    } finally {
      setBusy(false);
    }
  }
  const fill = (e: string) => { setEmail(e); setPassword('gccdemo'); };
  const [lead, ...rest] = branding.tagline.split(',');

  return (
    <div className="login">
      <div className="login-art" aria-hidden="true">
        <div className="blob blob-a" /><div className="blob blob-b" /><div className="blob blob-c" />
        <div className="login-copy">
          <span className="brand-mark big"><Icon name="sparkle" size={28} /></span>
          <h1>{rest.length ? <>{lead}, <em>{rest.join(',').trim()}</em></> : <>{branding.tagline || branding.appName}</>}</h1>
          <p>{branding.welcome || 'Find a desk, grab a room, catch an event, and say hi to the people who make the place feel like home.'}</p>
          <ul><li><Icon name="check" size={16} /> Real floor plan, live availability</li><li><Icon name="check" size={16} /> One tap to book, one scan to find</li><li><Icon name="check" size={16} /> Events, food, kudos and fun</li></ul>
        </div>
      </div>
      <form className="login-card" onSubmit={submit}>
        <h2>Welcome back</h2>
        <p className="muted">Sign in to {branding.appName}.</p>
        <Field label="Email or username"><input type="text" inputMode="email" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus placeholder="you@company.com or your employee ID" maxLength={200} /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="button button-primary button-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'} <Icon name="arrow" size={18} /></button>
        {demo && (
          <div className="demo-box">
            <strong>Local demo accounts</strong>
            <div className="demo-row">
              <button type="button" className="chip" onClick={() => fill('ava@demo.gcc')}>Employee</button>
              <button type="button" className="chip" onClick={() => fill('noah@demo.gcc')}>Admin</button>
              <button type="button" className="chip" onClick={() => fill('root@demo.gcc')}>Super admin</button>
              <button type="button" className="chip" onClick={() => fill('meera@demo.gcc')}>Facility manager</button>
              <button type="button" className="chip" onClick={() => fill('ravi@demo.gcc')}>Facility staff</button>
              <button type="button" className="chip" onClick={() => fill('emp-1001')}>Staff (employee ID)</button>
            </div>
            <small>Password for all of them: <code>gccdemo</code></small>
          </div>
        )}
      </form>
    </div>
  );
}

export default function App() {
  return <KitProvider><Shell /></KitProvider>;
}
