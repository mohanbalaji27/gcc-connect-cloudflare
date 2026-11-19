import { useRef, type KeyboardEvent } from 'react';
import { DIETS, type DietId } from '../lib/menuCatalog';
import './menu.css';

// The standard Indian food mark: a coloured square with a dot (a leaf for vegan).
export const DietMark = ({ diet, small = false }: { diet: DietId; small?: boolean }) => (
  <i className={`dmark dmark-${diet} ${small ? 'sm' : ''}`} role="img" aria-label={DIETS[diet].label} title={DIETS[diet].label} />
);
export const DietDot = ({ diet }: { diet: string }) => <DietMark diet={(diet in DIETS ? diet : 'veg') as DietId} small />;

export const Ornament = () => <div className="orn" aria-hidden="true"><span /><i /><span /></div>;

// Read-only stars; fractions are shown by filling part of the last star.
export function Stars({ value, label }: { value: number | null; label?: string }) {
  const v = Math.max(0, Math.min(5, value ?? 0));
  return <span className="stars" style={{ ['--v' as string]: `${(v / 5) * 100}%` }} role="img" aria-label={label ?? `${v.toFixed(1)} out of 5 stars`} />;
}

const HINTS = ['', 'Not good', 'Could be better', 'Okay', 'Good', 'Loved it'];

// Tap a star to rate; tap the same star again to clear it (when `clearable`). Arrow keys work too.
export function StarInput({ value, onChange, label, size = 'lg', clearable = false }: { value: number; onChange: (value: number) => void; label: string; size?: 'lg' | 'sm'; clearable?: boolean }) {
  const group = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent, next: number) => {
    event.preventDefault();
    const clamped = Math.max(clearable ? 0 : 1, Math.min(5, next));
    onChange(clamped);
    window.setTimeout(() => group.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus(), 0);
  };
  return (
    <div className={`star-input ${size}`} role="radiogroup" aria-label={label} ref={group}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} ${n === 1 ? 'star' : 'stars'}${HINTS[n] ? `, ${HINTS[n]}` : ''}`}
          className={n <= value ? 'on' : ''} tabIndex={value === n || (value === 0 && n === 1) ? 0 : -1}
          onClick={() => onChange(clearable && value === n ? 0 : n)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowUp') move(event, value + 1);
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') move(event, value - 1);
          }}
        >★</button>
      ))}
      {size === 'lg' && <span className="star-hint" aria-live="polite">{HINTS[value] ?? ''}</span>}
    </div>
  );
}
