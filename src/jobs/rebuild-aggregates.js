import { isMain, runJob } from '../runtime.js';

if (isMain(import.meta.url)) await runJob('rebuild-aggregates', (app) => app.rebuildAggregates(), { requireSecrets: false });
