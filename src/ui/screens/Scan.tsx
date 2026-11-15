import { useCallback, useEffect, useRef, useState } from 'react';
import type { IScannerControls } from '@zxing/browser';
import type { Resource } from '../../lib/types';
import { api, messageOf } from '../../lib/api';
import type { Ctx, QrIntent } from '../App';
import { Empty, Icon, useKit } from '../kit';

function parseQr(value: string): QrIntent | null {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    const resourceId = url.searchParams.get('resource');
    if (!resourceId) return null;
    return { resourceId, token: url.searchParams.get('token') ?? undefined, stay: url.searchParams.get('stay') ?? undefined };
  } catch {
    return /^[a-z0-9-]{1,64}$/.test(trimmed) ? { resourceId: trimmed } : null;
  }
}

export function ScanScreen({ onResolved }: { ctx: Ctx; onResolved: (intent: QrIntent) => void }) {
  const { toast } = useKit();
  const video = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Resource[]>([]);
  const [searched, setSearched] = useState(false);

  const alive = useRef(true);
  const wanted = useRef(false);
  const starting = useRef(false);
  const lastWarning = useRef(0);

  const stop = useCallback(() => { wanted.current = false; controls.current?.stop(); controls.current = null; setScanning(false); }, []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; controls.current?.stop(); controls.current = null; };
  }, []);

  async function start() {
    if (starting.current || controls.current) return;
    setError('');
    if (!navigator.mediaDevices?.getUserMedia) return setError('Camera scanning needs HTTPS or localhost. Use the search box instead.');
    starting.current = true;
    wanted.current = true;
    setScanning(true);
    let finished = false;
    let active: IScannerControls | undefined;
    try {
      const { BrowserQRCodeReader } = await import('@zxing/browser');
      if (!alive.current) return;
      const reader = new BrowserQRCodeReader();
      active = await reader.decodeFromConstraints({ video: { facingMode: { ideal: 'environment' } } }, video.current!, (result) => {
        if (!result || finished) return;
        const intent = parseQr(result.getText());
        if (!intent) {
          if (Date.now() - lastWarning.current > 3000) { lastWarning.current = Date.now(); toast('That QR isn’t a GCC Connect code.', 'error'); }
          return;
        }
        finished = true;
        active?.stop();
        controls.current = null;
        setScanning(false);
        onResolved(intent);
      });
      if (finished || !alive.current || !wanted.current) { active.stop(); return; }
      controls.current = active;
    } catch {
      active?.stop();
      if (alive.current) {
        setScanning(false);
        setError('We couldn’t open the camera. Check the browser permission, or search by seat number below.');
      }
    } finally {
      starting.current = false;
    }
  }

  async function search(event: React.FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    try {
      const result = await api<{ resources: Resource[] }>(`/resources?${new URLSearchParams({ q: query.trim() })}`);
      setSearched(true);
      const exact = result.resources.find((resource) => resource.label.toLowerCase() === query.trim().toLowerCase());
      if (exact) return onResolved({ resourceId: exact.id });
      setMatches(result.resources.slice(0, 8));
    } catch (reason) { toast(messageOf(reason), 'error'); }
  }

  return (
    <div className="scan">
      <div className="page-head"><div><span className="eyebrow">SCAN</span><h1>Found a QR on a desk?</h1></div></div>
      <div className="scan-grid">
        <section className="scan-card">
          <div className={`viewfinder ${scanning ? 'live' : ''}`}>
            <video ref={video} muted playsInline aria-label="Camera preview" />
            {!scanning && <div className="viewfinder-idle"><Icon name="scan" size={44} /><p>Point your camera at the QR sticker on a desk or room door.</p></div>}
            {scanning && <><i className="corner tl" /><i className="corner tr" /><i className="corner bl" /><i className="corner br" /><i className="scan-line" /></>}
          </div>
          {error && <div className="form-error" role="alert">{error}</div>}
          {scanning ? <button className="button button-block" onClick={stop}>Stop camera</button> : <button className="button button-primary button-block" onClick={() => void start()}><Icon name="scan" size={18} /> Start scanning</button>}
          <small className="muted">The camera only starts when you tap the button, and nothing is recorded.</small>
        </section>
        <section className="scan-card">
          <h2>No camera? No problem.</h2>
          <form onSubmit={search} className="search-inline">
            <div className="input-icon"><Icon name="search" size={18} /><input value={query} onChange={(e) => { setQuery(e.target.value); setSearched(false); }} placeholder="Seat number, e.g. Z045" maxLength={80} aria-label="Seat or room name" /></div>
            <button className="button button-primary">Find</button>
          </form>
          {matches.length > 0 && <ul className="space-list compact">{matches.map((resource) => <li key={resource.id}><button className="space-row" onClick={() => onResolved({ resourceId: resource.id })}><span className="space-icon"><Icon name={resource.type} size={18} /></span><span className="space-text"><strong>{resource.label}</strong><small>{resource.team?.name ?? resource.zone}</small></span><Icon name="arrow" size={16} /></button></li>)}</ul>}
          {searched && matches.length === 0 && <Empty icon="search" title="No match">Check the number on the desk sticker and try again.</Empty>}
        </section>
      </div>
    </div>
  );
}
