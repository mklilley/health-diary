import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, mkdir, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite, atomicWriteJson, readJson } from '../src/util/atomic-write.js';
import { withLock } from '../src/util/lock.js';
import { localDate, localTimestamp, localHour, validateDate, addDays, entryIdentity, finalisationCutoff } from '../src/util/dates.js';
import { safeError } from '../src/util/logging.js';
import { isTransient, createStepRunner } from '../src/util/retry.js';

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'health-diary-unit-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('atomic writes produce private, complete files and remove temporary artifacts', async t => {
  const root = await directory(t);
  const path = join(root, 'nested', 'metadata.json');
  await atomicWriteJson(path, { version: 1, value: 'synthetic-record' });
  await atomicWriteJson(path, { version: 2, value: 'replacement' });
  assert.deepEqual(await readJson(path), { version: 2, value: 'replacement' });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'nested'))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(join(root, 'nested')), ['metadata.json']);
  await atomicWrite(path, '{invalid');
  await assert.rejects(readJson(path, {}), SyntaxError);
  assert.equal(await readFile(path, 'utf8'), '{invalid');
});

test('writer leases serialize concurrent operations and release after failure', async t => {
  const root = await directory(t);
  let active = 0, maximum = 0, completed = 0;
  const work = () => withLock(root, async () => {
    active++; maximum = Math.max(active, maximum);
    await new Promise(resolve => setTimeout(resolve, 5));
    completed++; active--;
  });
  await Promise.all([work(), work(), work()]);
  assert.equal(maximum, 1);
  assert.equal(completed, 3);
  await assert.rejects(withLock(root, async () => { throw new Error('synthetic failure'); }));
  await withLock(root, async () => {});
});

test('a second live poller fails quickly and stale crashed leases are reclaimable', async t => {
  const root = await directory(t);
  await withLock(root, async () => {
    await assert.rejects(withLock(root, async () => {}, { name: 'poller', timeoutMs: 0 }), { code: 'ELOCKED' });
  }, { name: 'poller' });
  const path = join(root, '.writer.lock');
  await mkdir(path);
  const stale = new Date(Date.now() - 180_000);
  await utimes(path, stale, stale);
  await withLock(root, async () => {});
});

test('London timestamps distinguish both repeated DST hours and midnight boundaries', () => {
  assert.equal(localDate('2026-09-09T23:30:00Z'), '2026-09-10');
  assert.equal(localTimestamp('2026-03-29T00:59:59Z'), '2026-03-29T00:59:59+00:00');
  assert.equal(localTimestamp('2026-03-29T01:00:00Z'), '2026-03-29T02:00:00+01:00');
  assert.equal(localTimestamp('2026-10-25T00:30:00Z'), '2026-10-25T01:30:00+01:00');
  assert.equal(localTimestamp('2026-10-25T01:30:00Z'), '2026-10-25T01:30:00+00:00');
  assert.equal(localHour('2026-09-10T21:00:00Z'), 22);
  assert.equal(addDays('2026-03-30', -1), '2026-03-29');
  assert.equal(addDays('2026-10-26', -1), '2026-10-25');
  assert.equal(finalisationCutoff(new Date('2026-03-29T00:30:00Z')), '2026-03-27');
  assert.equal(finalisationCutoff(new Date('2026-03-29T01:00:00Z')), '2026-03-28');
});

test('strict ISO dates and deterministic identities reject normalized invalid dates', () => {
  for (const invalid of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-1-01', '../2026-01-01', '2026-01-01x']) assert.equal(validateDate(invalid), false);
  assert.equal(validateDate('2028-02-29'), true);
  assert.equal(entryIdentity({ date: Date.parse('2026-09-09T13:20:11Z') / 1000, message_id: 1247 }).entryId, '2026-09-09T14-20-11_001247');
});

test('logs/errors retain only safe operational details and classify intervention failures', () => {
  const error = Object.assign(new Error('SECRET_TOKEN and PRIVATE_CONTENT'), { status: 401, request: { body: 'PRIVATE_CONTENT' } });
  assert.deepEqual(safeError(error), { type: 'http', code: 'HTTP_401', message: 'Provider returned HTTP 401', status: 401 });
  assert.equal(isTransient(error), false);
  assert.equal(isTransient({ status: 429 }), true);
  assert.equal(isTransient({ status: 503 }), true);
  assert.equal(isTransient({ code: 'HEADER_MISMATCH' }), false);
  assert.equal(isTransient({ code: 'ECONNRESET' }), true);
});

test('retry backoff increases and long provider retry-after prevents premature attempts', async () => {
  const waits = [];
  let now = new Date('2026-09-09T12:00:00Z');
  const config = { immediateAttempts: 3, retryBaseMs: 1000, retryIntervalMs: 900_000, attentionAfterMs: 3_600_000 };
  const runner = createStepRunner({ config, now: () => now, sleep: async ms => waits.push(ms), random: () => 0.5 });
  const meta = { steps: {} };
  const save = async () => {};
  let attempts = 0;
  await runner.run(meta, 'transcription', save, async () => { attempts++; throw { status: 503 }; });
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [1000, 2000]);
  await runner.run(meta, 'transcription', save, async () => { attempts++; });
  assert.equal(attempts, 3);
  await runner.run(meta, 'sheet_entry', save, async () => { throw { status: 429, retryAfterSeconds: 3600 }; });
  assert.equal(meta.steps.sheet_entry.attempts, 1);
  assert.equal(meta.steps.sheet_entry.next_retry_at, '2026-09-09T13:00:00.000Z');
  now = new Date('2026-09-09T12:16:00Z');
  await runner.run(meta, 'sheet_entry', save, async () => { throw new Error('Must not run yet'); });
  assert.equal(meta.steps.sheet_entry.attempts, 1);
});
