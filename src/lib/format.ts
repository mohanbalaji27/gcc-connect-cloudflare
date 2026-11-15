const TZ = 'Asia/Kolkata';

export const inIndia = (date: Date | string, options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('en-IN', { timeZone: TZ, ...options }).format(typeof date === 'string' ? new Date(date) : date);

export function todayInIndia(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(Date.now() + offsetDays * 86_400_000));
  const v = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}

export const toInstant = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);

export function nowTimeInIndia() {
  return inIndia(new Date(), { hour: '2-digit', minute: '2-digit', hour12: false }).replace(/^24/, '00');
}

export function greeting(name: string) {
  const hour = Number(inIndia(new Date(), { hour: '2-digit', hour12: false })) % 24;
  const first = name.split(' ')[0];
  if (hour < 5) return `Burning the midnight oil, ${first}?`;
  if (hour < 12) return `Good morning, ${first}`;
  if (hour < 17) return `Good afternoon, ${first}`;
  return `Good evening, ${first}`;
}

export const timeRange = (start: string, end: string) =>
  `${inIndia(start, { hour: 'numeric', minute: '2-digit' })} – ${inIndia(end, { hour: 'numeric', minute: '2-digit' })}`;

export function relativeDay(iso: string) {
  const key = (d: Date | string) => inIndia(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  if (key(iso) === key(new Date())) return 'Today';
  if (key(iso) === key(new Date(Date.now() + 86_400_000))) return 'Tomorrow';
  return inIndia(iso, { weekday: 'short', day: 'numeric', month: 'short' });
}

const icsStamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export function downloadCalendarFile(title: string, location: string, startsAt: string, endsAt: string) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//GCC Connect//EN', 'BEGIN:VEVENT',
    `UID:${crypto.randomUUID()}@gcc-connect`, `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(new Date(startsAt))}`, `DTEND:${icsStamp(new Date(endsAt))}`,
    `SUMMARY:${title.replace(/[,;\n]/g, ' ')}`, `LOCATION:${location.replace(/[,;\n]/g, ' ')}`, 'END:VEVENT', 'END:VCALENDAR',
  ];
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title.replace(/\W+/g, '-').toLowerCase()}.ics`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const downloadDataUrl = (dataUrl: string, filename: string) => {
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  link.click();
};

export const dateKeyInIndia = (value: Date | string) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(typeof value === 'string' ? new Date(value) : value);
export const timeKeyInIndia = (value: Date | string) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(typeof value === 'string' ? new Date(value) : value).replace(/^24/, '00');
