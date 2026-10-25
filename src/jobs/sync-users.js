import { isMain, runJob } from '../runtime.js';

if (isMain(import.meta.url)) await runJob('sync-users', app => app.syncDirectory
  ? app.syncDirectory() : { skipped: 'single_user_installation' });
