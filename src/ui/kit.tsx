import { createPortal } from 'react-dom';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { normalizeUrl, splitUrl, urlProblem } from '../lib/url';

const PATHS: Record<string, string> = {
  home: 'M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10',
  desk: 'M3 9h18M5 9v10M19 9v10M7 9V5h10v4',
  room: 'M4 20V6l8-3 8 3v14M9 20v-5h6v5',
  scan: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10',
  calendar: 'M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1ZM4 10h16M8 3v4M16 3v4',
  ticket: 'M4 8a2 2 0 0 0 2-2h12a2 2 0 0 0 2 2v3a2 2 0 0 0 0 2v3a2 2 0 0 0-2 2H6a2 2 0 0 0-2-2v-3a2 2 0 0 0 0-2Z',
  shield: 'M12 3 4.5 6v5.5c0 4.5 3 7.7 7.5 9.5 4.5-1.8 7.5-5 7.5-9.5V6Z',
  users: 'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-4A3.5 3.5 0 0 0 5 17.5V19M10.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 19v-1.2a3 3 0 0 0-2.2-2.9M15.5 5.2a3 3 0 0 1 0 5.6',
  map: 'M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6ZM9 4v14M15 6v14',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  x: 'M6 6l12 12M18 6 6 18',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'M19 12H5M11 6l-6 6 6 6',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  pin: 'M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11ZM12 12a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4Z',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  logout: 'M10 5H6a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4M15 8l4 4-4 4M19 12H9',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
  edit: 'M4 20h4L19 9l-4-4L4 16v4ZM13.5 6.5l4 4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
  flame: 'M12 21c-3.5 0-6-2.4-6-5.8 0-2.2 1.2-3.7 2.4-5C9.7 8.8 10 7 9.7 4c3.3 1.6 5.7 4.5 5.7 7.4.8-.7 1.2-1.7 1.3-2.9 1.4 1.7 1.3 4 1.3 4.9 0 2.9-2.5 5.6-6 5.6Z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8ZM18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z',
  party: 'M4 20 8 8l8 8ZM13 4l.5 2M18 7l-1.5 1.2M19 12h2M10 4.5 11 6',
  key: 'M15 9a4 4 0 1 1-3.5 6L4 22v-3H2v-2l8-8a4 4 0 0 1 5-3ZM16.5 8.5h.01',
  qr: 'M4 4h6v6H4ZM14 4h6v6h-6ZM4 14h6v6H4ZM14 14h2v2h-2ZM18 14h2v2M14 18h2v2M18 18h2v2',
  layers: 'm12 3 9 5-9 5-9-5ZM3 13l9 5 9-5',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  move: 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3',
  select: 'M5 5h4M15 5h4M5 19h4M15 19h4M5 5v4M19 5v4M5 15v4M19 15v4',
  fit: 'M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4',
  lock: 'M6 11h12v9H6ZM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  copy: 'M9 9h10v11H9ZM5 15V4h10',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z',
  utensils: 'M7 3v8M4 3v5a3 3 0 0 0 6 0V3M7 11v10M17 21V3c-2.5 1.5-3.5 4-3.5 7 0 2 1.2 3 3.5 3',
  chart: 'M4 20V5M4 20h16M8 16v-4M12 16V8M16 16v-6',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z',
  mail: 'M4 6h16v12H4ZM4 7l8 6 8-6',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  megaphone: 'M4 10v4l12 5V5ZM16 9a3 3 0 0 1 0 6M7 14l1 6h3l-1-5',
  cake: 'M5 20h14v-6H5ZM5 14c1.5 1.5 3 1.5 4.5 0s3-1.5 4.5 0 3 1.5 5 0M12 10V6M12 4v.01',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z',
  poll: 'M5 20V10M12 20V4M19 20v-7',
  chat: 'M4 5h16v11H9l-5 4Z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 12l2-1-1-3-2 .5a7 7 0 0 0-1.5-1.5L17 5l-3-1-1 2a7 7 0 0 0-2 0L10 4 7 5l.5 2A7 7 0 0 0 6 8.5L4 8l-1 3 2 1a7 7 0 0 0 0 2l-2 1 1 3 2-.5A7 7 0 0 0 7.5 19L7 21l3 1 1-2a7 7 0 0 0 2 0l1 2 3-1-.5-2a7 7 0 0 0 1.5-1.5l2 .5 1-3-2-1a7 7 0 0 0 0-2Z',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
  grid: 'M4 4h7v7H4ZM13 4h7v7h-7ZM4 13h7v7H4ZM13 13h7v7h-7Z',
  print: 'M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2M7 14h10v6H7Z',
  gift: 'M4 9h16v4H4ZM5 13v7h14v-7M12 9v11M12 9c-3 0-4-4-1-4 2 0 1 4 1 4Zm0 0c3 0 4-4 1-4-2 0-1 4-1 4Z',
};

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={PATHS[name] ?? PATHS.sparkle} />
    </svg>
  );
}

type ToastKind = 'success' | 'error' | 'info';
interface Toast { id: number; message: string; kind: ToastKind }
interface Kit { toast: (message: string, kind?: ToastKind) => void; celebrate: () => void }
const KitContext = createContext<Kit>({ toast: () => {}, celebrate: () => {} });
export const useKit = () => useContext(KitContext);

const CONFETTI_COLORS = ['#d7f35a', '#2f9e6f', '#e8772e', '#6c5ce7', '#0984e3', '#e0457b', '#f6c945'];

export function KitProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [burst, setBurst] = useState(0);
  const counter = useRef(0);
  const toast = useCallback((message: string, kind: ToastKind = 'info') => {
    counter.current += 1;
    const id = counter.current;
    setToasts((current) => [...current.slice(-3), { id, message, kind }]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== id)), kind === 'error' ? 7000 : 4200);
  }, []);
  const celebrate = useCallback(() => {
    setBurst((value) => value + 1);
    window.setTimeout(() => setBurst(0), 2600);
  }, []);
  const value = useMemo(() => ({ toast, celebrate }), [toast, celebrate]);
  return (
    <KitContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((item) => (
          <div key={item.id} className={`toast toast-${item.kind}`}>
            <Icon name={item.kind === 'error' ? 'x' : item.kind === 'success' ? 'check' : 'sparkle'} size={18} />
            <span>{item.message}</span>
            <button className="toast-close" aria-label="Dismiss" onClick={() => setToasts((current) => current.filter((t) => t.id !== item.id))}><Icon name="x" size={14} /></button>
          </div>
        ))}
      </div>
      {burst > 0 && <Confetti key={burst} />}
    </KitContext.Provider>
  );
}

function Confetti() {
  const pieces = useMemo(() => Array.from({ length: 70 }, (_, index) => ({
    left: Math.random() * 100,
    delay: Math.random() * 0.35,
    duration: 1.6 + Math.random() * 1.2,
    drift: (Math.random() - 0.5) * 220,
    color: CONFETTI_COLORS[index % CONFETTI_COLORS.length],
    size: 6 + Math.random() * 7,
    spin: Math.random() * 720 - 360,
  })), []);
  return (
    <div className="confetti" aria-hidden="true">
      {pieces.map((piece, index) => (
        <i key={index} style={{ left: `${piece.left}%`, background: piece.color, width: piece.size, height: piece.size * 0.45, animationDelay: `${piece.delay}s`, animationDuration: `${piece.duration}s`, ['--drift' as string]: `${piece.drift}px`, ['--spin' as string]: `${piece.spin}deg` }} />
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="modal-head"><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <div className="spinner-wrap" role="status"><span className="spinner" /><span>{label}…</span></div>;
}

export function Empty({ icon = 'sparkle', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return <div className="empty"><span className="empty-icon"><Icon name={icon} size={26} /></span><strong>{title}</strong>{children && <p>{children}</p>}</div>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

// Web address input used everywhere: a fixed "https://" in front, bare domains and pasted links are cleaned up as you
// type (duplicate schemes dropped, spaces trimmed), and a mistake is explained under the box once you leave it.
export function UrlInput({ value, onChange, placeholder = 'example.com/page', required = false, ariaLabel, maxLength = 500 }: {
  value: string; onChange: (value: string) => void; placeholder?: string; required?: boolean; ariaLabel?: string; maxLength?: number;
}) {
  const [touched, setTouched] = useState(false);
  const { scheme, rest } = splitUrl(value);
  const problem = touched ? urlProblem(value) : null;
  const emit = (raw: string) => {
    const next = splitUrl(raw, scheme);
    onChange(next.rest ? `${next.scheme}://${next.rest}` : '');
  };
  return (
    <span className="url-field">
      <span className={`url-input ${problem ? 'is-invalid' : ''}`}>
        <span className="url-prefix" aria-hidden="true">{scheme}://</span>
        <input
          type="text" inputMode="url" autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
          value={rest} placeholder={placeholder} required={required} maxLength={maxLength} aria-label={ariaLabel} aria-invalid={Boolean(problem)}
          onChange={(event) => emit(event.target.value)}
          onBlur={() => { setTouched(true); const clean = normalizeUrl(value); if (clean !== value) onChange(clean); }}
        />
      </span>
      {problem && <small className="field-error" role="alert">{problem}</small>}
    </span>
  );
}

export function Avatar({ name, emoji, size = 38 }: { name: string; emoji?: string; size?: number }) {
  const initials = name.split(' ').map((part) => part[0]).slice(0, 2).join('').toUpperCase();
  return <span className={`avatar ${emoji ? 'avatar-emoji' : ''}`} style={{ width: size, height: size, fontSize: emoji ? size * 0.55 : size * 0.36 }} aria-hidden="true">{emoji || initials}</span>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; icon?: string; badge?: number }[]; value: T; onChange: (id: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button key={tab.id} role="tab" aria-selected={value === tab.id} className={value === tab.id ? 'active' : ''} onClick={() => onChange(tab.id)}>
          {tab.icon && <Icon name={tab.icon} size={17} />} {tab.label}{tab.badge ? <span className="tab-badge">{tab.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><i /></button>
  );
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  const safe = /^https?:\/\//i.test(href) ? href : undefined;
  return <a className="ext-link" href={safe} target="_blank" rel="noopener noreferrer">{children}</a>;
}
