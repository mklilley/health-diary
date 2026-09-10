import { isMain, runJob } from '../runtime.js';
import { validateDate } from '../util/dates.js';

if (isMain(import.meta.url)) {
  const [date, ...extra] = process.argv.slice(2);
  if (!validateDate(date) || extra.length) {
    process.stderr.write('Usage: npm run day -- YYYY-MM-DD (a valid calendar date)\n');
    process.exitCode = 1;
  } else {
    await runJob('day', (app) => app.showDay(date), { requireSecrets: false });
  }
}
