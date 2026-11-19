// Office days are Asia/Kolkata days (UTC+05:30, no daylight saving). Everything that groups by "day" goes through here.
export const OFFICE_TZ = 'Asia/Kolkata';
export const DAY_MS = 86_400_000;

export const dateKey = (date) => {
  const parts = new Intl.DateTimeFormat('en', { timeZone: OFFICE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
};
/** The instant an office day starts (00:00 IST). */
export const dayStart = (key) => new Date(`${key}T00:00:00+05:30`);
export const addDays = (key, days) => dateKey(new Date(Date.parse(`${key}T12:00:00+05:30`) + days * DAY_MS));
export const validDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
/** Whole days from a to b (both office-day keys). */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
/** 0 = Sunday ... 6 = Saturday, for an office day. */
export const weekdayOf = (key) => new Date(`${key}T12:00:00+05:30`).getUTCDay();
export const hourInIndia = (date) => Number(new Intl.DateTimeFormat('en', { timeZone: OFFICE_TZ, hour: '2-digit', hourCycle: 'h23' }).format(date));
