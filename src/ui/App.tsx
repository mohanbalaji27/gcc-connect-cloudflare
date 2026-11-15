import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppConfig, Branding, FeatureKey, MapInfo, Team, User } from '../lib/types';
import { api, ApiError, messageOf, setCsrf } from '../lib/api';
import { applyTheme } from '../lib/theme';
import { reloadFloorPlan, resetFloorPlan, type FloorPlanImage } from '../lib/floorplan';
import { Avatar, Icon, KitProvider, Spinner, useKit, Field } from './kit';
import { HomeScreen } from './screens/Home';
import { BookScreen } from './screens/Book';
import { BookingsScreen } from './screens/Bookings';
import { EventsScreen } from './screens/Events';
import { ScanScreen } from './screens/Scan';
import { ManageScreen } from './screens/Manage';
import { AccountScreen } from './screens/Account';
import { MenuScreen } from './screens/Menu';
import { CommunityScreen } from './screens/Community';
import { UsefulScreen } from './screens/Useful';
import { MoreScreen } from './screens/More';

export type Screen = 'home' | 'book' | 'bookings' | 'events' | 'scan' | 'manage' | 'account' | 'menu' | 'community' | 'useful' | 'more';
export type NavItem = [Screen, string, string];
export interface QrIntent { resourceId: string; token?: string; stay?: string }
const DEFAULT_BRANDING: Branding = { appName: 'GCC Connect', tagline: 'Your office day, sorted.', accent: 'green', welcome: '' };

export interface Ctx {
  user: User;
  config: AppConfig;
  flag: (key: FeatureKey) => boolean;
  reloadConfig: () => Promise<void>;
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

  const reloadTeams = useCallback(async () => {
    const result = await api<{ teams: Team[]; unassignedSeats: number }>('/teams');
    setTeams(result.teams);
    setUnassignedSeats(result.unassignedSeats);
  }, []);
  const reloadMap = useCallback(async () => { setMapInfo(await api<MapInfo>('/map')); }, []);
  const reloadConfig = useCallback(async () => {
    const next = await api<AppConfig>('/config');
    setConfig(next);
    setBranding(next.branding);
  }, []);
  const reloadPlan = useCallback(async () => {
    setPlanLoading(true);
    try { setPlan(await reloadFloorPlan()); } finally { setPlanLoading(false); }
  }, []);

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
    if (!ready) return;
    void reloadTeams().catch(() => {});
    void reloadMap().catch(() => {});
    void reloadConfig().catch(() => {
      setConfig((current) => current ?? { features: { links: true, contacts: true, menu: true, announcements: true, kudos: true, polls: true, celebrations: true, feedback: true, whosin: true, vibes: true }, branding: DEFAULT_BRANDING, featureCatalog: {} as AppConfig['featureCatalog'], accents: ['green', 'ocean', 'sunset', 'berry', 'mono'] });
    });
    void reloadPlan();
  }, [ready, reloadTeams, reloadMap, reloadConfig, reloadPlan]);

  useEffect(() => {
    const expired = () => { setCsrf(''); resetFloorPlan(); setPlan(null); setConfig(null); setUser(null); toast('Your session ended. Please sign in again.', 'info'); };
    window.addEventListener('gcc-auth-expired', expired);
    return () => window.removeEventListener('gcc-auth-expired', expired);
  }, [toast]);

  const handleQrParams = useCallback(async () => {
    const params = new URLSearchParams(location.search);
    const token = params.get('token');
    const resourceId = params.get('resource');
    const stay = params.get('stay') ?? undefined;
    if (!token && !resourceId) return;
    history.replaceState(null, '', location.pathname);
    if (resourceId) { setIntent({ resourceId, token: token ?? undefined, stay }); setScreen('book'); }
    else toast('That booking QR is missing its space. Ask an admin for a new one.', 'error');
  }, [toast]);

  useEffect(() => { if (ready) void handleQrParams(); }, [ready, handleQrParams]);

  const go = useCallback((next: Screen) => { setScreen(next); window.scrollTo({ top: 0, behavior: 'smooth' }); }, []);
  const clearIntent = useCallback(() => setIntent(null), []);
  const startBooking = useCallback((next: QrIntent | { kind: 'desk' | 'room' }) => { setIntent(next); setScreen('book'); window.scrollTo({ top: 0 }); }, []);

  async function signOut() {
    try { await api('/logout', { method: 'POST' }); } catch (reason) { if (!(reason instanceof ApiError) || reason.status !== 401) toast(messageOf(reason), 'error'); }
    setCsrf('');
    resetFloorPlan();
    setPlan(null);
    setTeams([]);
    setConfig(null);
    setUser(null);
    setScreen('home');
  }

  const ctx: Ctx | null = useMemo(
    () => (user && ready && config
      ? { user, config, flag: (key: FeatureKey) => config.features[key] !== false, reloadConfig, updateUser: setUser, plan, planLoading, teams, unassignedSeats, mapInfo, reloadTeams, reloadMap, reloadPlan, go, startBooking }
      : null),
    [user, ready, config, plan, planLoading, teams, unassignedSeats, mapInfo, reloadTeams, reloadMap, reloadConfig, reloadPlan, go, startBooking],
  );

  if (booting) return <div className="boot"><Spinner label="Warming up" /></div>;
  if (!user) return <LoginScreen branding={branding} onSignedIn={(next) => setUser(next)} />;
  if (user.mustChangePassword) return <AccountScreen user={user} forced onChanged={() => setUser({ ...user, mustChangePassword: false })} onSignOut={signOut} />;
  if (!ctx) return <div className="boot"><Spinner label="Getting things ready" /></div>;

  const manager = user.permissions.length > 0;
  const flag = ctx.flag;
  const hasCommunity = flag('kudos') || flag('polls') || flag('celebrations') || flag('feedback');
  const hasUseful = flag('links') || flag('contacts');
  const nav: NavItem[] = [
    ['home', 'Home', 'home'], ['book', 'Book', 'desk'], ['bookings', 'My bookings', 'ticket'], ['events', 'Events', 'party'],
    ...(flag('menu') ? [['menu', 'Food menu', 'utensils'] as NavItem] : []),
    ...(hasCommunity ? [['community', 'Community', 'heart'] as NavItem] : []),
    ...(hasUseful ? [['useful', 'Useful stuff', 'link'] as NavItem] : []),
    ['scan', 'Scan QR', 'scan'],
    ...(manager ? [['manage', 'Manage', 'shield'] as NavItem] : []),
  ];
  const mobileNav: NavItem[] = [
    ['home', 'Home', 'home'], ['book', 'Book', 'desk'], ['events', 'Events', 'party'],
    hasCommunity ? ['community', 'Community', 'heart'] : ['bookings', 'Trips', 'ticket'], ['more', 'More', 'grid'],
  ];
  const brandParts = branding.appName.trim().split(' ');
  const brandLast = brandParts.length > 1 ? brandParts.pop() : '';
  const brand = <span>{brandParts.join(' ')}{brandLast ? <> <b>{brandLast}</b></> : null}</span>;
  const roleLabel = user.role === 'super_admin' ? 'Super admin' : user.roleName ?? (user.role === 'admin' ? 'Admin' : user.team || 'Employee');
  const mobileActive = (id: Screen) => screen === id || (id === 'more' && !mobileNav.some(([m]) => m === screen));

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Icon name="sparkle" size={20} /></span>{brand}</div>
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
          {screen === 'home' && <HomeScreen ctx={ctx} />}
          {screen === 'book' && <BookScreen ctx={ctx} intent={intent} clearIntent={clearIntent} online={online} />}
          {screen === 'bookings' && <BookingsScreen ctx={ctx} />}
          {screen === 'events' && <EventsScreen ctx={ctx} />}
          {screen === 'scan' && <ScanScreen ctx={ctx} onResolved={(next) => { setIntent(next); setScreen('book'); }} />}
          {screen === 'menu' && flag('menu') && <MenuScreen ctx={ctx} />}
          {screen === 'community' && hasCommunity && <CommunityScreen ctx={ctx} />}
          {screen === 'useful' && hasUseful && <UsefulScreen ctx={ctx} />}
          {screen === 'more' && <MoreScreen ctx={ctx} items={nav.filter(([id]) => id !== 'home')} onSignOut={signOut} />}
          {screen === 'manage' && manager && <ManageScreen ctx={ctx} />}
          {screen === 'account' && <AccountScreen ctx={ctx} onChanged={() => toast('Password updated. Nicely done.', 'success')} onSignOut={signOut} />}
        </main>
      </div>
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
      const result = await api<{ user: User; csrfToken: string }>('/login', { method: 'POST', body: { email, password } });
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
        <Field label="Email"><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus placeholder="you@company.com" /></Field>
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
            </div>
            <small>Password for all three: <code>gccdemo</code></small>
          </div>
        )}
      </form>
    </div>
  );
}

export default function App() {
  return <KitProvider><Shell /></KitProvider>;
}
