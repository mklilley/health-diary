export const TIMEZONE = 'Europe/London';
const formatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  timeZoneName: 'longOffset',
});

function parts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid timestamp');
  return Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
}

export function localDate(value = new Date()) {
  const p = parts(value);
  return `${p.year}-${p.month}-${p.day}`;
}

export function localTimestamp(value = new Date()) {
  const p = parts(value);
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.replace('GMT', '');
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

export function localHour(value = new Date()) { return Number(parts(value).hour); }

export function validateDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function addDays(value, amount) {
  if (!validateDate(value) || !Number.isInteger(amount)) throw new Error('Invalid calendar date');
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function entryIdentity(message) {
  const receivedAt = localTimestamp(new Date(message.date * 1000));
  return {
    entryId: `${receivedAt.slice(0, 19).replaceAll(':', '-')}_${String(message.message_id).padStart(6, '0')}`,
    receivedAt, date: receivedAt.slice(0, 10),
  };
}

// Local date arithmetic, never subtract 24 hours across a DST boundary.
export function finalisationCutoff(now) {
  return addDays(localDate(now), localHour(now) >= 2 ? -1 : -2);
}
