import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { cronLine, pauseCron, resumeCron, runCron } from '../src/jobs/cron.js';

const execute = promisify(execFile);
// Starting a runner imports the provider SDKs as well as the application.
// Allow for a busy server running the whole suite; this is not a speed test.
const startupTimeoutMs = 30_000;
const fixtureRunTimeoutMs = 45_000;

async function fixture(t, source) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'health-diary-cron-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "diary ' $(no-command) `no-command`");
  await mkdir(join(root, 'src/jobs'), { recursive: true });
  await writeFile(join(root, 'src/jobs/retry.js'), source);
  return root;
}

async function waitFor(path, { running, logPath } = {}) {
  let outcome;
  running?.then(result => { outcome = { result }; }, error => { outcome = { error }; });
  const deadline = performance.now() + startupTimeoutMs;
  while (performance.now() < deadline) {
    if (outcome) {
      let log = '';
      if (logPath) {
        try { log = await readFile(logPath, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const { result, error } = outcome;
      assert.fail(`Process exited before creating ${path}\n${JSON.stringify({
        code: error?.code ?? result?.code ?? 0,
        signal: error?.signal ?? result?.signal,
        stdout: error?.stdout ?? result?.stdout,
        stderr: error?.stderr ?? result?.stderr,
      })}\n${log}`);
    }
    try { await stat(path); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(25);
  }
  assert.fail(`Timed out after ${startupTimeoutMs}ms waiting for ${path}`);
}

test('generated cron command preserves shell-sensitive paths in a minimal environment', async t => {
  const root = await fixture(t, '');
  await writeFile(join(root, 'src/jobs/cron.js'), 'console.log(process.argv[1]);');
  const line = cronLine({ root });
  assert.ok(line.startsWith('*/15 * * * * '));
  const result = await execute('/bin/sh', ['-c', line.slice('*/15 * * * * '.length)], {
    cwd: tmpdir(), env: { PATH: '/usr/bin:/bin' }, timeout: 5_000,
  });
  assert.equal(result.stdout.trim(), join(root, 'src/jobs/cron.js'));
  assert.equal(result.stderr, '');
  for (const suffix of ['%', '\n', '\r']) assert.throws(() => cronLine({ root: root + suffix }));
});

test('cron runs in the installation directory and captures output in private rotated logs', async t => {
  const root = await fixture(t, `
    console.log(JSON.stringify({ cwd: process.cwd(), tz: process.env.TZ, mode: process.env.NODE_ENV }));
    console.error('fixture stderr');
  `);
  await mkdir(join(root, 'logs'));
  const previous = 'x'.repeat(5 * 1024 * 1024);
  await writeFile(join(root, 'logs/cron.log'), previous);
  const result = await runCron({ root });
  assert.equal(result.code, 0);
  const log = await readFile(join(root, 'logs/cron.log'), 'utf8');
  assert.match(log, /cron_started/);
  assert.match(log, /cron_finished/);
  assert.ok(log.includes(JSON.stringify({ cwd: root, tz: 'Europe/London', mode: 'production' })));
  assert.ok(log.includes('fixture stderr'));
  assert.equal(await readFile(join(root, 'logs/cron.log.1'), 'utf8'), previous);
  assert.equal((await stat(join(root, 'logs'))).mode & 0o777, 0o700);
  for (const file of ['cron.log', 'cron.log.1']) {
    assert.equal((await stat(join(root, 'logs', file))).mode & 0o777, 0o600);
  }
});

test('cron skips overlapping passes and pause waits until the active pass finishes', async t => {
  const root = await fixture(t, `
    const fs = require('node:fs');
    fs.writeFileSync('started', '');
    const interval = setInterval(() => {
      if (fs.existsSync('release')) clearInterval(interval);
    }, 10);
  `);
  const first = runCron({ root, timeoutMs: fixtureRunTimeoutMs });
  const pending = [first];
  try {
    await waitFor(join(root, 'started'), { running: first, logPath: join(root, 'logs/cron.log') });
    assert.deepEqual(await runCron({ root }), { code: 0, skipped: 'already_running' });
    let paused = false;
    const pause = pauseCron({ root }).then(() => { paused = true; });
    pending.push(pause);
    await waitFor(join(root, 'logs/cron.paused'));
    assert.equal(paused, false);
    assert.deepEqual(await runCron({ root }), { code: 0, skipped: 'paused' });
    await writeFile(join(root, 'release'), '');
    assert.equal((await first).code, 0);
    await pause;
    assert.equal(paused, true);
    assert.deepEqual(await runCron({ root }), { code: 0, skipped: 'paused' });
    await resumeCron({ root });
    assert.equal((await runCron({ root })).code, 0);
  } finally {
    await writeFile(join(root, 'release'), '');
    await Promise.allSettled(pending);
  }
});

test('terminating the cron runner stops its child and releases its lease', async t => {
  const root = await fixture(t, `
    require('node:fs').writeFileSync('started', '');
    setInterval(() => {}, 1000);
  `);
  const moduleUrl = new URL('../src/jobs/cron.js', import.meta.url).href;
  const source = `import { runCron } from ${JSON.stringify(moduleUrl)};
    process.exitCode = (await runCron({ root: ${JSON.stringify(root)}, timeoutMs: ${fixtureRunTimeoutMs} })).code;`;
  const running = execute(process.execPath, ['--input-type=module', '-e', source], {
    env: { PATH: '/usr/bin:/bin' }, timeout: 60_000,
  });
  // Observe failures immediately, without an assertion in background cleanup
  // replacing a useful startup error or becoming an unhandled rejection.
  const completed = running.then(result => ({ result }), error => ({ error }));
  try {
    await waitFor(join(root, 'started'), { running, logPath: join(root, 'logs/cron.log') });
    running.child.kill('SIGTERM');
    const { error } = await completed;
    assert.equal(error?.code, 1);
    assert.equal(error.signal, null);
    assert.match(await readFile(join(root, 'logs/cron.log'), 'utf8'), /"signal":"SIGTERM"/);
    await writeFile(join(root, 'src/jobs/retry.js'), '');
    assert.equal((await runCron({ root })).code, 0);
  } finally {
    if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill('SIGTERM');
    await completed;
  }
});

test('cron preserves job failures and releases the lock after killing a hung job', async t => {
  const root = await fixture(t, 'process.exitCode = 7;');
  assert.equal((await runCron({ root })).code, 7);
  await writeFile(join(root, 'src/jobs/retry.js'), 'setInterval(() => {}, 1000);');
  assert.deepEqual(await runCron({ root, timeoutMs: 150 }), { code: 1, signal: 'SIGKILL' });
  assert.match(await readFile(join(root, 'logs/cron.log'), 'utf8'), /cron_failed/);
  await writeFile(join(root, 'src/jobs/retry.js'), '');
  assert.equal((await runCron({ root })).code, 0);
});
