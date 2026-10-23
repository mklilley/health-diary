import { validateDate } from '../util/dates.js';

function adjacentMonth(month, offset) {
  const date = new Date(`${month}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  const next = date.toISOString().slice(0, 7);
  return validateDate(`${next}-01`) ? next : null;
}

// UTC is used only for calendar arithmetic; the initial month comes from the
// diary's London date, so DST cannot change the chosen day.
export function calendar(month, button) {
  if (!validateDate(`${month}-01`)) throw new Error('Invalid calendar month');
  const first = new Date(`${month}-01T12:00:00Z`);
  const title = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first);
  const rows = [['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(day => button(day, 'noop'))];
  let week = Array.from({ length: (first.getUTCDay() + 6) % 7 }, () => button('·', 'noop'));
  for (let day = 1; day <= 31; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    if (!validateDate(date)) break;
    week.push(button(String(day), 'day', date));
    if (week.length === 7) { rows.push(week); week = []; }
  }
  if (week.length) {
    while (week.length < 7) week.push(button('·', 'noop'));
    rows.push(week);
  }
  rows.push([-1, 1].map(offset => {
    const next = adjacentMonth(month, offset);
    return button(offset === -1 ? '‹ Previous month' : 'Next month ›', next ? 'month' : 'noop', next || '');
  }));
  return { title, rows };
}
