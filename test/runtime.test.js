import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('PM2 wrapper launches the configured entrypoint', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'health-diary-pm2-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const wrapper = join(cwd, 'ProcessContainerFork.cjs');
  // PM2 imports its configured script without changing process.argv[1].
  await writeFile(wrapper, "import(require('node:url').pathToFileURL(process.env.pm_exec_path));\n");
  const launch = script => execute(process.execPath, [wrapper], {
    cwd,
    env: { PATH: process.env.PATH, DATA_DIR: join(cwd, 'data'), pm_exec_path: join(root, script) },
    timeout: 15_000,
  });
  // No credentials: reaching configuration validation proves main() ran,
  // without contacting Telegram, Google or OpenAI.
  await assert.rejects(launch('src/bot/bot.js'), error => {
    assert.match(error.stderr, /Missing required configuration: TELEGRAM_DIARY_USER_ID/);
    return error.code === 1;
  });
  assert.match((await launch('src/jobs/status.js')).stdout, /# Health Diary Status/);
});

test('importing bot and job modules does not start them', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'health-diary-import-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const importer = join(cwd, 'importer.mjs');
  await writeFile(importer, ['src/bot/bot.js', 'src/jobs/status.js']
    .map(script => `await import(${JSON.stringify(pathToFileURL(join(root, script)).href)});`)
    .join('\n'));
  for (const pm2Env of [{}, { pm_exec_path: importer }]) {
    const result = await execute(process.execPath, [importer], {
      cwd,
      env: { PATH: process.env.PATH, DATA_DIR: join(cwd, 'data'), ...pm2Env },
      timeout: 15_000,
    });
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

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
    assert.match(error.stderr, /Missing required configuration: TELEGRAM_DIARY_USER_ID/);
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
