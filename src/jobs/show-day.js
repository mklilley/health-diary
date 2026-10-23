import { isMain, runJob } from '../runtime.js';
import { validateDate } from '../util/dates.js';

if (isMain(import.meta.url)) {
  const [date, owner, ...extra] = process.argv.slice(2);
  if (!validateDate(date) || extra.length || (owner !== undefined && (!/^[1-9]\d*$/.test(owner) || !Number.isSafeInteger(Number(owner))))) {
    process.stderr.write('Usage: npm run day -- YYYY-MM-DD [Telegram-user-ID] (ID required in multi-user mode)\n');
    process.exitCode = 1;
  } else {
    await runJob('day', (app) => app.showDay(date, owner === undefined ? undefined : Number(owner)), { requireSecrets: false });
  }
}
