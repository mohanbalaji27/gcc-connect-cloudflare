import { toInstant } from './format';

export interface StayOption { code: string; label: string }

// "d240" = stay for 240 minutes; "u1700" = stay until 5:00 pm; "u2400" = until midnight (the next day at 00:00).
export const STAY_OPTIONS: StayOption[] = [
  { code: 'd30', label: '30 min' }, { code: 'd60', label: '1 hour' }, { code: 'd120', label: '2 hours' }, { code: 'd240', label: '4 hours' }, { code: 'd480', label: 'Full day (8 h)' },
  { code: 'u1700', label: 'Until 5:00 pm' }, { code: 'u2000', label: 'Until 8:00 pm' }, { code: 'u2400', label: 'Until midnight' },
];

export const isStayCode = (value: unknown): value is string => typeof value === 'string' && STAY_OPTIONS.some((option) => option.code === value);

const nextDay = (date: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.parse(`${date}T12:00:00+05:30`) + 86_400_000));

export function stayEnd(date: string, time: string, code: string): Date {
  const start = toInstant(date, time);
  if (code.startsWith('d')) return new Date(start.getTime() + Number(code.slice(1)) * 60_000);
  const clock = code.slice(1);
  if (clock === '2400') return toInstant(nextDay(date), '00:00');
  return toInstant(date, `${clock.slice(0, 2)}:${clock.slice(2)}`);
}

// Options that make sense for this start time (e.g. "until 5 pm" is hidden once you arrive after 4:30 pm).
export function validStays(kind: 'desk' | 'room', date: string, time: string): StayOption[] {
  const start = toInstant(date, time).getTime();
  return STAY_OPTIONS.filter((option) => {
    if (kind === 'desk' && option.code === 'd30') return false;
    const minutes = (stayEnd(date, time, option.code).getTime() - start) / 60_000;
    if (minutes < 30) return false;
    return kind === 'room' ? minutes <= 480 : minutes <= 1440;
  });
}

const KEY = 'gcc-stay';
export const rememberedStay = (): string | null => { const value = localStorage.getItem(KEY); return isStayCode(value) ? value : null; };
export const rememberStay = (code: string) => localStorage.setItem(KEY, code);
