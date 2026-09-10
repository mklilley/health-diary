import { isMain, runJob } from '../runtime.js';

if (isMain(import.meta.url)) await runJob('status', (app) => app.status(), { requireSecrets: false });
