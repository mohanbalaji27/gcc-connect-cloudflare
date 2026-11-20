import { useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import type { Branding, LoginConfig, LogoMeta } from '../lib/types';
import { hasLogo, loginCardText, loginImageUrl, loginTip, logoUrl } from '../lib/brand';
import { Field, Icon } from './kit';

/** True while the page is in dark mode; follows the Auto / Light / Dark switch live. */
export function useIsDark(): boolean {
  const read = () => document.documentElement.dataset.theme === 'dark';
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

type Place = 'bar' | 'art' | 'card';

/**
 * The logo (or the name as a wordmark). Bars and the sign-in art are always dark, so they prefer the dark-mode logo and
 * otherwise put the normal logo on a small white badge; the sign-in card follows light / dark mode the same way.
 */
export function BrandMark({ branding, logo, place, dark: forced, height }: { branding: Branding; logo: LogoMeta; place: Place; dark?: boolean; height?: number }) {
  const darkMode = useIsDark();
  const onDark = place !== 'card' || (forced ?? darkMode);
  const useLogo = hasLogo(logo) && branding.logoDisplay !== 'text';
  const words = branding.appName.trim().split(' ');
  const last = words.length > 1 ? words.pop() : '';
  const wordmark = <span className="brand-text">{words.join(' ')}{last ? <> <b>{last}</b></> : null}</span>;
  if (!useLogo) {
    const withIcon = !hasLogo(logo);
    return <span className="brand-lockup">{withIcon && <span className={`brand-mark ${place === 'art' ? 'big' : ''}`}><Icon name="sparkle" size={place === 'art' ? 28 : place === 'bar' ? 20 : 22} /></span>}{wordmark}</span>;
  }
  const slotName = place === 'card' || place === 'art' ? 'login' : 'header';
  const darkSlot = `${slotName}Dark` as const;
  const hasDarkVariant = logo.slots.includes(darkSlot);
  const slot = onDark && hasDarkVariant ? darkSlot : slotName;
  const badge = onDark && !hasDarkVariant;
  const size = height ?? (place === 'bar' ? branding.logoHeight : place === 'art' ? 56 : 48);
  return (
    <span className={`brand-lockup has-logo ${badge ? 'on-badge' : ''}`} data-align={branding.logoAlign}>
      <img className="brand-logo" src={logoUrl(logo, slot)} alt={branding.logoDisplay === 'logo-text' ? '' : branding.appName} style={{ height: size }} decoding="async" />
      {branding.logoDisplay === 'logo-text' && wordmark}
    </span>
  );
}

export interface LoginFormState { login: string; password: string; busy: boolean; error: string }
interface LoginViewProps {
  branding: Branding; login: LoginConfig; logo: LogoMeta;
  /** Preview mode draws the same page without any behaviour (used by Settings). */
  preview?: boolean;
  state?: LoginFormState; onChange?: (patch: Partial<Pick<LoginFormState, 'login' | 'password'>>) => void; onSubmit?: (event: FormEvent) => void;
  demo?: ReactNode;
}

export function LoginView({ branding, login, logo, preview = false, state, onChange, onSubmit, demo }: LoginViewProps) {
  const [lead, ...rest] = (login.title || branding.tagline).split(',');
  const headline = login.title ? <>{login.title}</> : rest.length ? <>{lead}, <em>{rest.join(',').trim()}</em></> : <>{branding.tagline || branding.appName}</>;
  const body = login.subtitle || branding.welcome || 'Find a desk, grab a room, catch an event, and say hi to the people who make the place feel like home.';
  const tip = login.showTip ? loginTip() ?? (preview ? 'Tip: friendly tips will show up here.' : null) : null;
  const image = login.background === 'image' ? loginImageUrl(logo) : '';
  const artStyle: CSSProperties | undefined = image ? ({ ['--login-image' as string]: `url("${image}")` } as CSSProperties) : undefined;
  const values = state ?? { login: '', password: '', busy: false, error: '' };
  const background = login.background === 'image' && !image ? 'gradient' : login.background;
  return (
    <div className={`login login-bg-${background} login-card-${login.card}`}>
      <div className="login-art" aria-hidden={preview ? undefined : 'true'} style={artStyle}>
        <div className="blob blob-a" /><div className="blob blob-b" /><div className="blob blob-c" />
        <div className="login-copy">
          {login.showLogo && <div className="login-logo"><BrandMark branding={branding} logo={logo} place="art" /></div>}
          <h1>{headline}</h1>
          <p>{body}</p>
          {login.bullets.length > 0 && <ul>{login.bullets.map((item) => <li key={item}><Icon name="check" size={16} /> {item}</li>)}</ul>}
        </div>
      </div>
      <form className="login-card" onSubmit={onSubmit} noValidate={preview}>
        <fieldset className="login-fields" disabled={preview}>
          <h2>{login.cardTitle}</h2>
          <p className="muted">{loginCardText(login.cardText, branding.appName)}</p>
          <Field label="Email or username" hint={login.usernameHint || undefined}>
            <input type="text" inputMode="email" autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="username" value={values.login} onChange={(event) => onChange?.({ login: event.target.value })} required autoFocus={!preview} placeholder="you@company.com or your employee ID" maxLength={200} />
          </Field>
          <Field label="Password"><input type="password" autoComplete="current-password" value={values.password} onChange={(event) => onChange?.({ password: event.target.value })} required /></Field>
          {values.error && <div className="form-error" role="alert">{values.error}</div>}
          <button className="button button-primary button-block" disabled={values.busy}>{values.busy ? 'Signing in…' : 'Sign in'} <Icon name="arrow" size={18} /></button>
          {login.forgotHelp && <p className="login-help">{login.forgotHelp}</p>}
          {tip && <p className="login-tip">💡 {tip}</p>}
        </fieldset>
        {demo}
        {(login.footerText || login.footerLinks.length > 0) && (
          <div className="login-foot">
            {login.footerText && <span>{login.footerText}</span>}
            {login.footerLinks.length > 0 && <span className="login-links">{login.footerLinks.map((link) => <a key={link.url} href={preview ? undefined : link.url} target={/^https?:/i.test(link.url) ? '_blank' : undefined} rel="noopener noreferrer">{link.label}</a>)}</span>}
          </div>
        )}
      </form>
    </div>
  );
}
