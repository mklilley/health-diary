import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createDiary } from '../src/diary/index.js';
import { atomicWrite, atomicWriteJson, exists } from '../src/util/atomic-write.js';
import { handleUpdate } from '../src/bot/handlers.js';

// Synthetic source strings deliberately contain no real diary/health material.
const AUDIO = Buffer.from('OggS-synthetic-test-audio');
async function fixture(t, initial = '2026-09-09T12:00:00Z') {
  const dataDir = await mkdtemp(join(tmpdir(), 'health-diary-core-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let instant = new Date(initial);
  let telegramId = 1000;
  const calls = [], sent = [], folders = new Map(), files = new Map(), rows = new Map(), days = new Map(), faults = new Map();
  const config = {
    dataDir, timezone: 'Europe/London', sisterUserId: 101, adminUserId: 202,
    transcriptionModel: 'test-transcription', entrySummaryModel: 'test-entry', dailySummaryModel: 'test-day',
    googleDriveRootFolderId: 'private-test-root', googleSheetId: 'private-test-sheet',
    diaryStartDate: '2026-09-09', immediateAttempts: 3, retryBaseMs: 0,
    retryIntervalMs: 0, attentionAfterMs: 3_600_000, retainLocalAudio: true,
  };
  const record = (operation, args) => { calls.push({ operation, args }); };
  function fail(operation) {
    const fault = faults.get(operation);
    if (!fault || fault.remaining <= 0) return;
    fault.remaining -= 1;
    throw Object.assign(new Error('Synthetic provider failure'), { status: fault.status });
  }
  const services = {
    telegram: {
      downloadVoice: async (fileId) => { record('download', fileId); fail('download'); return AUDIO; },
      sendMessage: async (chatId, text) => {
        record('telegram', { chatId, text });
        fail('telegram');
        sent.push({ chatId, text });
        return { message_id: ++telegramId };
      },
    },
    openai: {
      transcribe: async (path, options) => {
        record('transcribe', { path, options }); fail('transcribe');
        assert.deepEqual(await readFile(path), AUDIO);
        return `Raw source ${basename(dirname(path))}. Additional primary detail.`;
      },
      summarizeEntry: async (transcript, options) => {
        record('summarizeEntry', { transcript, options }); fail('summarizeEntry');
        return `Stored short summary for ${transcript.split('.')[0]}.`;
      },
      summarizeDay: async (transcripts, options) => {
        record('summarizeDay', { transcripts, options }); fail('summarizeDay');
        return `Stored daily summary for ${options.date} with ${transcripts.length} sources.`;
      },
    },
    drive: {
      ensureFolder: async (parentId, name) => {
        record('folder', { parentId, name }); fail('folder');
        const key = `${parentId}/${name}`;
        if (!folders.has(key)) folders.set(key, { id: `folder-${folders.size + 1}` });
        return folders.get(key);
      },
      putFile: async (options) => {
        record('putFile', options); fail(`drive:${options.name}`);
        const key = `${options.parentId}/${options.name}`;
        const file = { id: files.get(key)?.id ?? `file-${files.size + 1}`, content: await readFile(options.path, 'utf8'), ...options };
        files.set(key, file);
        return { id: file.id, webViewLink: `https://drive.google.com/file/d/${file.id}/view` };
      },
    },
    sheets: {
      upsertEntry: async (entry) => { record('sheetEntry', entry); fail('sheetEntry'); rows.set(entry.entryId, entry); return { row: rows.size + 1 }; },
      upsertDay: async (day) => { record('sheetDay', day); fail('sheetDay'); days.set(day.date, day); return { row: days.size + 1 }; },
    },
  };
  const now = () => new Date(instant);
  const options = { config, services, now, sleep: async () => {}, random: () => 0.5 };
  const app = await createDiary(options);
  const voice = (id = 1, at = instant) => ({ message_id: id, date: Math.floor(new Date(at).getTime() / 1000),
    from: { id: 101 }, chat: { id: 101, type: 'private' }, voice: { file_id: `test-voice-${id}` } });
  const entryDirectory = (entry) => join(dataDir, 'entries', entry.date, entry.entry_id);
  return {
    app, options, config, services, calls, sent, folders, files, rows, days, faults, now, voice,
    setNow: value => { instant = new Date(value); },
    fault: (operation, status = 503, remaining = Infinity) => faults.set(operation, { status, remaining }),
    entryDirectory,
    entry: async (entry) => JSON.parse(await readFile(join(entryDirectory(entry), 'metadata.json'), 'utf8')),
    day: async date => JSON.parse(await readFile(join(dataDir, 'days', date, 'metadata.json'), 'utf8')),
    count: operation => calls.filter(call => call.operation === operation).length,
  };
}

test('normal sister voice preserves primary files and reuses one exact summary in every destination', async (t) => {
  const f = await fixture(t);
  const receipt = await handleUpdate({ message: f.voice() }, f);
  const path = f.entryDirectory(receipt);
  assert.deepEqual(await readFile(join(path, 'audio.ogg')), AUDIO);
  const transcript = await readFile(join(path, 'transcript.md'), 'utf8');
  const summary = await readFile(join(path, 'summary.md'), 'utf8');
  assert.match(transcript, /Additional primary detail/);
  assert.equal(f.count('transcribe'), 1);
  assert.equal(f.count('summarizeEntry'), 1);
  assert.equal(f.rows.get(receipt.entry_id).summary, summary);
  assert.deepEqual(f.sent.filter(message => message.chatId === 101).map(message => message.text), [`Recorded ✓\n\n${summary}`]);
  const meta = await f.entry(receipt);
  assert.equal(meta.transcription_model, 'test-transcription');
  assert.ok(meta.entry_summary_prompt_version);
  assert.ok(Object.values(meta.steps).every(step => step.status === 'complete'));
  assert.equal(f.files.get(`${meta.drive_folder_id}/summary.md`).content, summary);
  assert.equal(f.files.get(`${meta.drive_folder_id}/transcript.md`).content, transcript);
  assert.equal(f.files.get(`${meta.drive_folder_id}/audio.ogg`).content, AUDIO.toString());
  assert.ok(f.files.has(`${meta.drive_folder_id}/metadata.json`));
});

test('duplicate Telegram delivery creates one entry, one row and one set of Drive objects', async (t) => {
  const f = await fixture(t);
  const first = await handleUpdate({ message: f.voice() }, f);
  const objects = f.files.size;
  const second = await handleUpdate({ message: f.voice() }, f);
  assert.equal(second.entry_id, first.entry_id);
  assert.equal((await readdir(join(f.config.dataDir, 'entries', first.date))).length, 1);
  assert.equal(f.rows.size, 1);
  assert.equal(f.files.size, objects);
  assert.equal(f.count('transcribe'), 1);
  assert.equal(f.count('summarizeEntry'), 1);
  assert.equal(f.sent.filter(message => message.text.startsWith('Recorded ✓')).length, 1);
});

test('temporary Drive failure keeps local sources, still acknowledges and resumes after restart', async (t) => {
  const f = await fixture(t);
  f.fault('drive:audio.ogg');
  const receipt = await handleUpdate({ message: f.voice() }, f);
  let meta = await f.entry(receipt);
  assert.equal(meta.steps.drive_audio.status, 'retry');
  assert.equal(meta.steps.drive_audio.attempts, 3);
  assert.equal(meta.steps.transcription.status, 'complete');
  assert.deepEqual(await readFile(join(f.entryDirectory(receipt), 'audio.ogg')), AUDIO);
  assert.equal(f.sent.filter(message => message.text.startsWith('Recorded ✓')).length, 1);
  f.faults.clear();
  const restarted = await createDiary(f.options);
  await restarted.retry({ force: true });
  meta = await f.entry(receipt);
  assert.equal(meta.steps.drive_audio.status, 'complete');
  assert.equal(meta.steps.sheet_entry.status, 'complete');
  assert.equal(f.count('transcribe'), 1);
  assert.equal(f.count('summarizeEntry'), 1);
  assert.equal(f.rows.size, 1);
  assert.equal(f.sent.filter(message => message.text.startsWith('Recorded ✓')).length, 1);
});

test('interrupted running metadata resumes without regenerating existing primary or derived files', async (t) => {
  const f = await fixture(t);
  const receipt = await handleUpdate({ message: f.voice() }, f);
  const meta = await f.entry(receipt);
  meta.steps.transcription.status = 'running';
  meta.steps.entry_summary.status = 'running';
  await atomicWriteJson(join(f.entryDirectory(receipt), 'metadata.json'), meta);
  const restarted = await createDiary(f.options);
  await restarted.retry({ force: true });
  assert.equal(f.count('transcribe'), 1);
  assert.equal(f.count('summarizeEntry'), 1);
  assert.equal((await f.entry(receipt)).steps.entry_summary.status, 'complete');
});

test('persistent authentication failure emits one attention alert and one resolution alert', async (t) => {
  const f = await fixture(t);
  f.fault('drive:audio.ogg', 401);
  const receipt = await handleUpdate({ message: f.voice() }, f);
  await f.app.retry({ force: true });
  let meta = await f.entry(receipt);
  assert.equal(meta.steps.drive_audio.status, 'attention');
  assert.equal(meta.attention.required, true);
  const attentionAlerts = () => f.sent.filter(message => message.chatId === 202 && /needs attention/.test(message.text) && /drive_audio/.test(message.text));
  const resolvedAlerts = () => f.sent.filter(message => message.chatId === 202 && /issue resolved/.test(message.text) && /drive_audio/.test(message.text));
  assert.equal(attentionAlerts().length, 1);
  f.faults.clear();
  await f.app.retry({ force: true });
  await f.app.retry({ force: true });
  meta = await f.entry(receipt);
  assert.equal(meta.steps.drive_audio.status, 'complete');
  assert.equal(meta.attention.required, false);
  assert.equal(attentionAlerts().length, 1);
  assert.equal(resolvedAlerts().length, 1);
});

test('an hour-old transient failure becomes attention while remaining recoverable', async (t) => {
  const f = await fixture(t);
  f.fault('drive:audio.ogg');
  const receipt = await handleUpdate({ message: f.voice() }, f);
  f.setNow('2026-09-09T13:01:00Z');
  await f.app.retry({ force: true });
  assert.equal((await f.entry(receipt)).steps.drive_audio.status, 'attention');
  f.faults.clear();
  await f.app.retry({ force: true });
  assert.equal((await f.entry(receipt)).steps.drive_audio.status, 'complete');
});

test('zero-entry day completes without AI and is added to Days exactly once', async (t) => {
  const f = await fixture(t, '2026-09-10T02:00:00Z');
  await f.app.recordPoll();
  await f.app.daily();
  const day = await f.day('2026-09-09');
  assert.equal(day.entry_count, 0);
  assert.equal(day.steps.daily_summary.status, 'complete');
  assert.equal(await readFile(join(f.config.dataDir, 'days', day.date, 'summary.md'), 'utf8'), 'No entries recorded.');
  assert.deepEqual(f.days.get(day.date), { date: day.date, summary: 'No entries recorded.', entryCount: 0 });
  await f.app.daily();
  assert.equal(f.days.size, 1);
  assert.equal(f.count('summarizeDay'), 0);
});

test('daily finalisation waits for the Telegram backlog and every transcript, then uses raw sources in order', async (t) => {
  const f = await fixture(t);
  // Receive the later voice first to exercise chronological source ordering.
  const later = await f.app.receiveVoice(f.voice(2, '2026-09-09T16:00:00Z'));
  const earlier = await f.app.receiveVoice(f.voice(1, '2026-09-09T09:00:00Z'));
  await f.app.processEntry(earlier.entry_id);
  f.fault('transcribe');
  await f.app.processEntry(later.entry_id);
  assert.equal(f.sent.filter(message => /couldn't transcribe/.test(message.text)).length, 1);
  f.setNow('2026-09-10T02:00:00Z');
  await f.app.daily();
  assert.equal(f.count('summarizeDay'), 0);
  await f.app.recordPoll();
  await f.app.daily();
  assert.equal((await f.day('2026-09-09')).steps.daily_summary.status, 'retry');
  assert.equal(f.count('summarizeDay'), 0);
  f.faults.clear();
  await f.app.retry({ force: true });
  await f.app.daily();
  const request = f.calls.find(call => call.operation === 'summarizeDay');
  assert.deepEqual(request.args.transcripts.map(source => source.entry_id), [earlier.entry_id, later.entry_id]);
  assert.ok(request.args.transcripts.every(source => source.transcript.includes('Additional primary detail.')));
  assert.ok(request.args.transcripts.every(source => !source.transcript.includes('Stored short summary')));
  assert.equal((await f.day('2026-09-09')).steps.daily_summary.status, 'complete');
  assert.equal(f.count('summarizeDay'), 1);
  assert.equal(f.sent.filter(message => message.text.startsWith('Recorded ✓')).length, 2);
});

test('corrections append new entries and retrospective comments cannot regenerate a completed old day', async (t) => {
  const f = await fixture(t);
  const first = await handleUpdate({ message: f.voice(1) }, f);
  const originals = await Promise.all(['audio.ogg', 'transcript.md', 'summary.md'].map(name => readFile(join(f.entryDirectory(first), name))));
  f.setNow('2026-09-09T14:00:00Z');
  const correction = await handleUpdate({ message: f.voice(2) }, f);
  assert.notEqual(first.entry_id, correction.entry_id);
  for (const [index, name] of ['audio.ogg', 'transcript.md', 'summary.md'].entries()) assert.deepEqual(await readFile(join(f.entryDirectory(first), name)), originals[index]);
  f.setNow('2026-09-10T02:00:00Z');
  await f.app.recordPoll();
  await f.app.daily();
  const oldSummary = await readFile(join(f.config.dataDir, 'days', '2026-09-09', 'summary.md'));
  f.setNow('2026-09-10T10:00:00Z');
  const retrospective = await handleUpdate({ message: f.voice(3) }, f);
  assert.equal(retrospective.date, '2026-09-10');
  await f.app.daily();
  await f.app.retry({ force: true });
  assert.deepEqual(await readFile(join(f.config.dataDir, 'days', '2026-09-09', 'summary.md')), oldSummary);
  assert.equal(f.count('summarizeDay'), 1);
  assert.equal((await f.day('2026-09-09')).summary_entry_count, 2);
  assert.match(await f.app.lastDay(), /2026-09-09/);
});

test('today remains a list of existing entry summaries until finalisation; viewing it never calls AI', async (t) => {
  const f = await fixture(t);
  const receipt = await handleUpdate({ message: f.voice() }, f);
  const summary = await readFile(join(f.entryDirectory(receipt), 'summary.md'), 'utf8');
  const view = await f.app.showDay('2026-09-09');
  assert.ok(view.includes(summary));
  assert.match(view, /2026-09-09/);
  assert.equal(f.count('summarizeDay'), 0);
});

test('reminder sends once after 22:00; sister text and admin activity do not suppress it', async (t) => {
  const f = await fixture(t, '2026-09-09T21:05:00Z');
  await handleUpdate({ message: { ...f.voice(), voice: undefined, text: 'Synthetic interaction' } }, f);
  await handleUpdate({ message: { ...f.voice(), from: { id: 202 }, chat: { id: 202, type: 'private' } } }, f);
  await f.app.recordPoll();
  assert.equal((await f.app.reminder()).sent, true);
  assert.equal((await f.app.reminder()).sent, false);
  assert.equal(f.sent.filter(message => message.chatId === 101 && /haven't recorded/.test(message.text)).length, 1);
  assert.equal((await f.day('2026-09-09')).reminder_sent, true);
  f.setNow('2026-09-10T08:00:00Z');
  assert.equal((await f.app.reminder()).sent, false);
  assert.equal(f.sent.filter(message => /haven't recorded/.test(message.text)).length, 1);
});

test('a durable voice receipt suppresses the reminder even before audio download or transcription', async (t) => {
  const f = await fixture(t, '2026-09-09T21:00:00Z');
  await f.app.receiveVoice(f.voice());
  assert.equal((await f.app.reminder()).sent, false);
  assert.equal(f.count('transcribe'), 0);
  assert.equal(f.sent.length, 0);
});

test('status and aggregate files can be deleted and rebuilt from authoritative individual records', async (t) => {
  const f = await fixture(t);
  const receipt = await handleUpdate({ message: f.voice() }, f);
  f.setNow('2026-09-10T02:00:00Z');
  await f.app.recordPoll();
  await f.app.daily();
  const aggregateNames = ['all-transcripts.md', 'all-entry-summaries.md', 'all-daily-summaries.md'];
  await f.app.rebuildAggregates();
  const originals = await Promise.all(aggregateNames.map(name => readFile(join(f.config.dataDir, 'aggregates', name), 'utf8')));
  await rm(join(f.config.dataDir, 'status'), { recursive: true });
  await rm(join(f.config.dataDir, 'aggregates'), { recursive: true });
  const status = await f.app.status();
  assert.match(status, /2026-09-09/);
  assert.equal(await readFile(join(f.config.dataDir, 'status', 'STATUS.md'), 'utf8'), status);
  assert.equal(typeof JSON.parse(await readFile(join(f.config.dataDir, 'status', 'index.json'), 'utf8')), 'object');
  await f.app.rebuildAggregates();
  for (const [index, name] of aggregateNames.entries()) assert.equal(await readFile(join(f.config.dataDir, 'aggregates', name), 'utf8'), originals[index]);
  assert.ok(originals[0].includes(receipt.entry_id));
  assert.ok(originals[0].includes('Additional primary detail.'));
});

test('concurrent duplicate receipts share a writer lease and cannot create two entries', async t => {
  const f = await fixture(t);
  const [one, two] = await Promise.all([f.app.receiveVoice(f.voice()), f.app.receiveVoice(f.voice())]);
  assert.equal(one.entry_id, two.entry_id);
  assert.equal((await readdir(join(f.config.dataDir, 'entries', one.date))).length, 1);
  assert.equal((await f.day(one.date)).entry_count, 1);
});

test('an ambiguous acknowledgement is held across retries/restarts without duplicate sending', async t => {
  const f = await fixture(t);
  const send = f.services.telegram.sendMessage;
  let acknowledgements = 0;
  f.services.telegram.sendMessage = async (id, text) => {
    if (text.startsWith('Recorded ✓')) {
      acknowledgements++;
      await send(id, text); // Provider accepted it but its response was lost.
      throw Object.assign(new Error('Synthetic lost response'), { code: 'ECONNRESET' });
    }
    return send(id, text);
  };
  const receipt = await handleUpdate({ message: f.voice() }, f);
  const restart = await createDiary(f.options);
  await restart.retry({ force: true });
  const metadata = await f.entry(receipt);
  assert.equal(metadata.steps.telegram_acknowledgement.status, 'attention');
  assert.equal(metadata.steps.telegram_acknowledgement.ambiguous_delivery, true);
  assert.equal(acknowledgements, 1);
  assert.equal(f.sent.filter(message => /needs attention/.test(message.text)).length, 1);
  assert.match(await restart.status(), /telegram_acknowledgement/);
});

test('a crash with a running acknowledgement does not resend it', async t => {
  const f = await fixture(t);
  const receipt = await handleUpdate({ message: f.voice() }, f);
  const metadata = await f.entry(receipt);
  metadata.steps.telegram_acknowledgement.status = 'running';
  await atomicWriteJson(join(f.entryDirectory(receipt), 'metadata.json'), metadata);
  await f.app.retry({ force: true });
  assert.equal(f.sent.filter(message => message.text.startsWith('Recorded ✓')).length, 1);
  assert.equal((await f.entry(receipt)).steps.telegram_acknowledgement.ambiguous_delivery, true);
});

test('one shared Drive authentication outage creates one alert and one resolution', async t => {
  const f = await fixture(t);
  f.fault('folder', 401);
  await handleUpdate({ message: f.voice() }, f);
  await handleUpdate({ message: f.voice(2) }, f);
  await f.app.retry({ force: true });
  assert.equal(f.sent.filter(message => /needs attention/.test(message.text)).length, 1);
  f.faults.clear();
  await f.app.retry({ force: true });
  await f.app.retry({ force: true });
  assert.equal(f.sent.filter(message => /issue resolved/.test(message.text)).length, 1);
});

test('polling failures persist in status, alert once and resolve after the backlog drains', async t => {
  const f = await fixture(t);
  await f.app.recordPollFailure({ status: 401 });
  await f.app.recordPollFailure({ status: 401 });
  assert.match(await f.app.status(), /telegram_poll: attention/);
  assert.equal(f.sent.filter(message => /needs attention/.test(message.text)).length, 1);
  await f.app.recordPoll();
  await f.app.recordPoll();
  assert.equal(f.sent.filter(message => /issue resolved/.test(message.text)).length, 1);
  assert.doesNotMatch(await f.app.status(), /telegram_poll: attention/);
});

test('audio cleanup is permitted only after transcription and verified Drive archival', async t => {
  const f = await fixture(t);
  f.config.retainLocalAudio = false;
  f.fault('transcribe', 503);
  const receipt = await handleUpdate({ message: f.voice() }, f);
  const audio = join(f.entryDirectory(receipt), 'audio.ogg');
  assert.equal(await exists(audio), true);
  assert.equal((await f.entry(receipt)).steps.drive_audio.status, 'complete');
  f.faults.clear();
  await f.app.retry({ force: true });
  assert.equal(await exists(audio), false);
  assert.equal((await f.entry(receipt)).local_audio_removed, true);
  assert.doesNotMatch(await f.app.status(), /missing_audio/);

  f.fault('drive:audio.ogg', 503);
  const second = await handleUpdate({ message: f.voice(2) }, f);
  assert.equal((await f.entry(second)).steps.transcription.status, 'complete');
  assert.equal(await exists(join(f.entryDirectory(second), 'audio.ogg')), true);
});

test('a missing primary transcript is visible and cannot overwrite the last good aggregate', async t => {
  const f = await fixture(t);
  const receipt = await handleUpdate({ message: f.voice() }, f);
  const aggregate = join(f.config.dataDir, 'aggregates', 'all-transcripts.md');
  const previous = await readFile(aggregate, 'utf8');
  await rm(join(f.entryDirectory(receipt), 'transcript.md'));
  const result = await f.app.rebuildAggregates();
  assert.equal(result.rebuilt, false);
  assert.equal(await readFile(aggregate, 'utf8'), previous);
  assert.match(await f.app.status(), /missing_transcription_file/);
  assert.equal(f.count('transcribe'), 1);
});

test('corrupt derived aggregate state never prevents status or aggregate recovery', async t => {
  const f = await fixture(t);
  await handleUpdate({ message: f.voice() }, f);
  const metadataPath = join(f.config.dataDir, 'aggregates', 'metadata.json');
  for (const invalid of ['{broken', '{"schema_version":1,"steps":null}']) {
    await atomicWrite(metadataPath, invalid);
    assert.match(await f.app.status(), /Aggregate upload state is unreadable/);
    assert.equal((await f.app.rebuildAggregates()).rebuilt, true);
  }
  const objects = f.files.size;
  await f.app.retry({ force: true });
  assert.equal(f.files.size, objects);
});

test('a reminder waits for recent polling and reserves uncertain delivery without resending', async t => {
  const f = await fixture(t, '2026-09-09T21:00:00Z');
  assert.equal((await f.app.reminder()).reason, 'waiting_for_recent_telegram_poll');
  await f.app.recordPoll();
  f.setNow('2026-09-09T21:06:00Z');
  assert.equal((await f.app.reminder()).reason, 'waiting_for_recent_telegram_poll');
  await f.app.recordPoll();
  f.fault('telegram', 503);
  assert.equal((await f.app.reminder()).sent, false);
  f.faults.clear();
  assert.equal((await f.app.reminder()).sent, false);
  assert.equal((await f.day('2026-09-09')).reminder_sent, true);
  assert.match(await f.app.status(), /reminder_delivery: attention/);
});

test('downtime catches up every due zero-entry day and never completes today', async t => {
  const f = await fixture(t, '2026-09-12T01:00:00Z');
  await f.app.recordPoll();
  await f.app.daily();
  assert.deepEqual([...f.days.keys()], ['2026-09-09', '2026-09-10', '2026-09-11']);
  assert.equal(f.count('summarizeDay'), 0);
  assert.equal(await exists(join(f.config.dataDir, 'days', '2026-09-12', 'summary.md')), false);
});

test('an undelivered transcription-delay notice is superseded when transcription recovers', async t => {
  const f = await fixture(t);
  f.fault('transcribe', 503);
  f.fault('telegram', 429);
  const receipt = await handleUpdate({ message: f.voice() }, f);
  assert.equal((await f.entry(receipt)).steps.telegram_pending_notice.status, 'retry');
  f.faults.clear();
  await f.app.retry({ force: true });
  const metadata = await f.entry(receipt);
  assert.equal(metadata.steps.telegram_pending_notice.status, 'complete');
  assert.equal(metadata.steps.telegram_pending_notice.superseded, true);
  assert.equal(f.sent.filter(message => message.text.startsWith('Recorded ✓')).length, 1);
  assert.equal(f.sent.filter(message => /couldn't transcribe/.test(message.text)).length, 0);
});
