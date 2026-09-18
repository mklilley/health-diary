import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { withLock } from '../src/util/lock.js';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('PM2 wrapper launches the configured entrypoint', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'health-diary-pm2-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const wrapper = join(cwd, 'ProcessContainerFork.cjs');
  // PM2 imports its configured script without changing process.argv[1]. Its
  // monitoring handles can keep a bot process alive after startup has failed.
  await writeFile(wrapper, "if (process.env.pm_exec_path.endsWith('/bot.js')) setInterval(() => {}, 1000);\nimport(require('node:url').pathToFileURL(process.env.pm_exec_path));\n");
  const launch = script => execute(process.execPath, [wrapper], {
    cwd,
    env: { PATH: process.env.PATH, DATA_DIR: join(cwd, 'data'), pm_exec_path: join(root, script) },
    timeout: 30_000, killSignal: 'SIGKILL',
  });
  // No credentials: reaching configuration validation proves main() ran,
  // without contacting Telegram, Google or OpenAI.
  await assert.rejects(launch('src/bot/bot.js'), error => {
    assert.match(error.stderr, /Missing required configuration: TELEGRAM_DIARY_USER_ID/);
    return error.code === 1;
  });
  assert.match((await launch('src/jobs/status.js')).stdout, /# Health Diary Status/);
});

test('supervised bot exits on a busy poller lock and recovers on restart with clean shutdown', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'health-diary-pm2-lock-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const dataDir = join(cwd, 'data');
  const wrapper = join(cwd, 'ProcessContainerFork.cjs');
  await writeFile(wrapper, `
    setInterval(() => {}, 1000);
    globalThis.fetch = async (url, options) => {
      if (!url.endsWith('/getUpdates')) throw new Error('Unexpected provider call');
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        process.kill(process.pid, 'SIGTERM');
      });
    };
    import(require('node:url').pathToFileURL(process.env.pm_exec_path));
  `);
  // Synthetic credentials only instantiate clients. Fetch is mocked above;
  // no provider is contacted and no real installation files are read.
  await writeFile(join(cwd, 'client.json'), JSON.stringify({ installed: { client_id: 'fixture', client_secret: 'fixture' } }));
  await writeFile(join(cwd, 'token.json'), JSON.stringify({ refresh_token: 'fixture' }));
  const launch = () => execute(process.execPath, [wrapper], {
    cwd, timeout: 30_000, killSignal: 'SIGKILL',
    env: {
      PATH: process.env.PATH, DATA_DIR: dataDir, pm_exec_path: join(root, 'src/bot/bot.js'),
      TELEGRAM_DIARY_USER_ID: '101', TELEGRAM_ADMIN_USER_ID: '202', TELEGRAM_BOT_TOKEN: 'fixture',
      OPENAI_API_KEY: 'fixture', GOOGLE_DRIVE_ROOT_FOLDER_ID: 'fixture', GOOGLE_SHEET_ID: 'fixture',
      GOOGLE_CREDENTIALS_FILE: join(cwd, 'client.json'), GOOGLE_TOKEN_FILE: join(cwd, 'token.json'),
    },
  });
  await withLock(dataDir, async () => {
    await assert.rejects(launch(), error => {
      assert.match(error.stdout, /"event":"bot_failed","code":"ELOCKED"/);
      assert.doesNotMatch(error.stdout, /bot_started/);
      assert.equal(error.signal, null, 'failed startup must exit itself, without timeout or supervisor intervention');
      return error.code === 1;
    });
  }, { name: 'poller', timeoutMs: 0 });
  const result = await launch();
  assert.match(result.stdout, /bot_started/);
  assert.match(result.stdout, /bot_stopped/);
  assert.doesNotMatch(result.stdout, /bot_failed/);
  // SIGTERM must release the lease before the process exits.
  await withLock(dataDir, async () => {}, { name: 'poller', timeoutMs: 0 });
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
