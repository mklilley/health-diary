import { isMain, runJob } from '../runtime.js';

if (isMain(import.meta.url)) await runJob('retry', (app) => app.retry());
