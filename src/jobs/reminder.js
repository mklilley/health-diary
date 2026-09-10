import { isMain, runJob } from '../runtime.js';

if (isMain(import.meta.url)) await runJob('reminder', (app) => app.reminder());
