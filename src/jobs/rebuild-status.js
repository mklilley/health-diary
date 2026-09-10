import { isMain, runJob } from '../runtime.js';

if (isMain(import.meta.url)) await runJob('rebuild-status', (app) => app.status(), { requireSecrets: false });
