import { useId, useState } from 'react';

/** A small "i" button that reveals, right in the layout (no floating popover to clip on a phone), what a number counts. */
export function InfoToggle({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button type="button" className={`info-btn ${open ? 'on' : ''}`} aria-expanded={open} aria-controls={id} aria-label={`What “${label}” counts`} title={text} onClick={() => setOpen((value) => !value)}>i</button>
      {open && <p id={id} className="info-text" role="note">{text}</p>}
    </>
  );
}
