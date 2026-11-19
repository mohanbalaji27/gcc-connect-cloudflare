import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { Resource, TokenRow } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import { dateKeyInIndia, downloadDataUrl, inIndia, timeKeyInIndia, todayInIndia, toInstant } from '../../lib/format';
import { STAY_OPTIONS } from '../../lib/stay';
import { Empty, Field, Icon, Spinner, useKit } from '../kit';
import type { Ctx } from '../App';

export function ManageQr({ ctx }: { ctx: Ctx }) {
  const { toast } = useKit();
  const [resources, setResources] = useState<Resource[]>([]);
  const [people, setPeople] = useState<{ id: string; name: string; email: string }[]>([]);
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [resourceId, setResourceId] = useState('');
  const [mode, setMode] = useState<'label' | 'noexpiry' | 'expiry' | 'report'>('noexpiry');
  const [expiryDate, setExpiryDate] = useState(todayInIndia(7));
  const [expiryTime, setExpiryTime] = useState('18:00');
  const [uses, setUses] = useState<'unlimited' | 'limited'>('unlimited');
  const [maxUses, setMaxUses] = useState('1');
  const [person, setPerson] = useState('');
  const [result, setResult] = useState<{ image: string; url: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [suggestStay, setSuggestStay] = useState('');

  const loadTokens = useCallback(async () => {
    try { setTokens((await api<{ tokens: TokenRow[] }>('/admin/tokens')).tokens); } catch (reason) { toast(messageOf(reason), 'error'); setTokens([]); }
  }, [toast]);

  useEffect(() => {
    void api<{ resources: Resource[] }>('/resources').then((r) => { setResources(r.resources); setResourceId(r.resources[0]?.id ?? ''); }).catch(() => {});
    void api<{ employees: { id: string; name: string; email: string }[] }>('/admin/employee-options').then((r) => setPeople(r.employees)).catch(() => {});
    void loadTokens();
  }, [loadTokens]);

  // Draws the QR with the seat or room name printed under it, so a pasted sticker is readable without scanning.
  async function render(url: string, label: string, subtitle: string) {
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 560, errorCorrectionLevel: 'M', color: { dark: '#163f31', light: '#ffffff' } });
    const img = new Image();
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('Could not draw the QR.')); img.src = qr; });
    const pad = 40; const qrSize = 560; const width = qrSize + pad * 2; const height = qrSize + pad * 2 + 150;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, width, height);
    g.drawImage(img, pad, pad, qrSize, qrSize);
    g.fillStyle = '#163f31'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    let size = 96;
    g.font = `800 ${size}px Segoe UI, Arial, sans-serif`;
    while (g.measureText(label).width > width - pad * 2 && size > 36) { size -= 4; g.font = `800 ${size}px Segoe UI, Arial, sans-serif`; }
    g.fillText(label, width / 2, qrSize + pad * 2 + 70);
    g.fillStyle = '#52665b'; g.font = '500 34px Segoe UI, Arial, sans-serif';
    g.fillText(subtitle.slice(0, 40), width / 2, qrSize + pad * 2 + 120);
    setResult({ image: canvas.toDataURL('image/png'), url, label });
  }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    const resource = resources.find((item) => item.id === resourceId);
    if (!resource) return;
    const stayParam = suggestStay ? `&stay=${suggestStay}` : '';
    const subtitle = [resource.type === 'desk' ? 'Desk' : 'Room', resource.team?.name ?? resource.zone].filter(Boolean).join(' \u00b7 ');
    setBusy(true);
    try {
      if (mode === 'report') {
        // Not a secret: anyone signed in can use it, and it only opens the problem form pointing at this place.
        await render(`${location.origin}/?report=${encodeURIComponent(resource.id)}`, resource.label, 'Scan to report a problem');
        toast('Report-a-problem sticker ready. Print it and stick it on.', 'success');
      } else if (mode === 'label') {
        await render(`${location.origin}/?resource=${encodeURIComponent(resource.id)}${stayParam}`, resource.label, subtitle);
        toast('Permanent label ready — print it and stick it on.', 'success');
      } else {
        const body: Record<string, unknown> = { resourceId, eligibleEmployeeId: person || undefined, maxRedemptions: uses === 'unlimited' ? null : Number(maxUses) };
        if (mode === 'noexpiry') body.noExpiry = true;
        else {
          const when = toInstant(expiryDate, expiryTime);
          if (Number.isNaN(when.getTime())) throw new Error('Choose a valid expiry.');
          body.expiresAt = when.toISOString();
        }
        const created = await api<{ token: string }>('/admin/tokens', { method: 'POST', body });
        await render(`${location.origin}/?resource=${encodeURIComponent(resource.id)}&token=${encodeURIComponent(created.token)}${stayParam}`, resource.label, subtitle);
        toast('Booking QR created. Copy it now — the code is shown only once.', 'success');
        void loadTokens();
      }
    } catch (reason) { toast(messageOf(reason), 'error'); } finally { setBusy(false); }
  }

  async function revoke(id: string) {
    try { await api(`/admin/tokens/${id}`, { method: 'DELETE' }); toast('QR revoked.', 'success'); void loadTokens(); } catch (reason) { toast(messageOf(reason), 'error'); }
  }

  return (
    <div className="two-col">
      <form className="panel form-stack" onSubmit={create}>
        <h2>Create a QR code</h2>
        <Field label="Space"><select value={resourceId} onChange={(e) => setResourceId(e.target.value)}>{resources.map((r) => <option key={r.id} value={r.id}>{r.label} · {r.type}</option>)}</select></Field>
        <fieldset className="radio-set">
          <legend>Type</legend>
          <label><input type="radio" checked={mode === 'label'} onChange={() => setMode('label')} /> <span><strong>Permanent label</strong><small>Opens the space so anyone signed in can book it normally.</small></span></label>
          <label><input type="radio" checked={mode === 'noexpiry'} onChange={() => setMode('noexpiry')} /> <span><strong>Booking code · no expiry</strong><small>Works until you revoke it.</small></span></label>
          <label><input type="radio" checked={mode === 'expiry'} onChange={() => setMode('expiry')} /> <span><strong>Booking code · expires</strong><small>Stops working at the time you choose.</small></span></label>
          {ctx.flag('issues') && <label><input type="radio" checked={mode === 'report'} onChange={() => setMode('report')} /> <span><strong>Report-a-problem sticker</strong><small>Scanning opens the issue form already pointing at this seat or room.</small></span></label>}
        </fieldset>
        {mode === 'expiry' && <div className="two"><Field label="Expires on"><input type="date" value={expiryDate} min={todayInIndia()} onChange={(e) => setExpiryDate(e.target.value)} required /></Field><Field label="At"><input type="time" value={expiryTime} onChange={(e) => setExpiryTime(e.target.value)} required /></Field></div>}
        {mode !== 'label' && mode !== 'report' && (
          <>
            <div className="two">
              <Field label="Uses"><select value={uses} onChange={(e) => setUses(e.target.value as 'unlimited' | 'limited')}><option value="unlimited">Unlimited</option><option value="limited">Limited</option></select></Field>
              {uses === 'limited' && <Field label="Max uses"><input type="number" min={1} max={10000} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} /></Field>}
            </div>
            <Field label="Only for (optional)"><select value={person} onChange={(e) => setPerson(e.target.value)}><option value="">Anyone signed in</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.email}</option>)}</select></Field>
          </>
        )}
        {mode !== 'report' && <Field label="Suggested stay when scanned" hint="People can still change it before booking. Leave on &ldquo;Their usual&rdquo; to use each person's last choice."><select value={suggestStay} onChange={(e) => setSuggestStay(e.target.value)}><option value="">Their usual</option>{STAY_OPTIONS.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}</select></Field>}
        <button className="button button-primary" disabled={busy || !resourceId}>{busy ? 'Working…' : mode === 'label' ? 'Generate label' : mode === 'report' ? 'Generate sticker' : 'Create booking QR'}</button>
        {result && (
          <div className="qr-result">
            <img src={result.image} alt={`QR code for ${result.label}`} width={220} />
            <div className="modal-actions left">
              <button type="button" className="button button-small" onClick={() => downloadDataUrl(result.image, `qr-${result.label.replace(/\W+/g, '-')}.png`)}><Icon name="download" size={16} /> PNG</button>
              <button type="button" className="button button-small" onClick={() => void navigator.clipboard.writeText(result.url).then(() => toast('Link copied.', 'success'))}><Icon name="copy" size={16} /> Copy link</button>
            </div>
          </div>
        )}
      </form>
      <section className="panel">
        <h2>Recent booking codes</h2>
        {tokens === null ? <Spinner /> : tokens.length === 0 ? <Empty icon="qr" title="No booking codes yet">Create one on the left.</Empty> : (
          <ul className="plain-list">
            {tokens.map((token) => {
              const expired = token.expires_at && new Date(token.expires_at).getTime() < Date.now();
              const exhausted = token.max_redemptions !== null && token.redemption_count >= token.max_redemptions;
              const state = token.revoked ? 'Revoked' : expired ? 'Expired' : exhausted ? 'Used up' : 'Active';
              return (
                <li key={token.id}>
                  <div><strong>{token.label}</strong><small>{token.expires_at ? `Expires ${dateKeyInIndia(token.expires_at)} ${timeKeyInIndia(token.expires_at)}` : 'No expiry'} · {token.redemption_count}{token.max_redemptions ? ` / ${token.max_redemptions}` : ''} used · created {inIndia(token.created_at, { day: 'numeric', month: 'short' })}</small></div>
                  <span className={`pill ${state === 'Active' ? 'pill-ok' : 'pill-off'}`}>{state}</span>
                  {state === 'Active' && <button className="button button-small button-danger-soft" onClick={() => void revoke(token.id)}>Revoke</button>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
