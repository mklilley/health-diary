import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('offline job entrypoints run from a clean environment and rebuild disposable views', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'health-diary-runtime-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, DATA_DIR: join(cwd, 'data'), TZ: 'UTC' };
  const job = async (name, args = []) => execute(process.execPath, [join(root, `src/jobs/${name}.js`), ...args], { cwd, env });
  assert.match((await job('status')).stdout, /# Health Diary Status/);
  assert.match((await job('show-day', ['2026-09-09'])).stdout, /Number of entries so far: 0/);
  assert.match((await job('rebuild-aggregates')).stdout, /all-transcripts.md/);
  await rm(join(cwd, 'data', 'status'), { recursive: true });
  assert.match((await job('rebuild-status')).stdout, /# Health Diary Status/);
  assert.match(await readFile(join(cwd, 'data', 'aggregates', 'all-transcripts.md'), 'utf8'), /^# All transcripts/);
  await assert.rejects(job('show-day', ['2026-02-30']), error => error.code === 1);
  await assert.rejects(execute(process.execPath, [join(root, 'src/bot/bot.js')], { cwd, env }), error => {
    assert.match(error.stderr, /Missing required configuration: TELEGRAM_SISTER_USER_ID/);
    return error.code === 1;
  });
});

test('production templates preserve one poller, London schedules and restricted write locations', async () => {
  const require = createRequire(import.meta.url);
  const { apps } = require('../ecosystem.config.cjs');
  assert.equal(apps.length, 1);
  assert.equal(apps[0].instances, 1);
  assert.equal(apps[0].exec_mode, 'fork');
  assert.equal(resolve(apps[0].cwd), resolve(root));
  assert.equal(apps[0].script, 'src/bot/bot.js');
  assert.equal(apps[0].autorestart, true);
  for (const [name, schedule] of [['retry', '*:00/15:00'], ['reminder', '22:00:00'], ['daily', '02:00:00']]) {
    const service = await readFile(join(root, `deploy/systemd/health-diary-${name}.service`), 'utf8');
    const timer = await readFile(join(root, `deploy/systemd/health-diary-${name}.timer`), 'utf8');
    assert.ok(timer.includes(`OnCalendar=*-*-* ${schedule} Europe/London`));
    assert.ok(timer.includes('Persistent=true'));
    assert.ok(service.includes('WorkingDirectory=/srv/health-diary'));
    assert.ok(service.includes(`ExecStart=/usr/bin/env node src/jobs/${name}.js`));
    assert.ok(service.includes('User=health-diary'));
    assert.ok(service.includes('UMask=0077'));
    assert.ok(service.includes('ReadWritePaths=/srv/health-diary/data /srv/health-diary/tokens'));
  }
});
