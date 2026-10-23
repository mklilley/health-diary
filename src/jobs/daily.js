import { isMain, runJob } from '../runtime.js';

if (isMain(import.meta.url)) {
  await runJob('daily', async app => {
    const result = await app.daily();
    return Array.isArray(result) ? { days_checked: result.length } : result;
  });
}
