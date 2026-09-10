import { isMain, runJob } from '../runtime.js';

if (isMain(import.meta.url)) {
  await runJob('daily', async (app) => ({ days_checked: (await app.daily()).length }));
}
