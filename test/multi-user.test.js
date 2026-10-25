import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../src/runtime.js';
import { createMultiDiary } from '../src/diary/multi.js';
import { createDiary } from '../src/diary/index.js';
import { createDiaryArchive } from '../src/services/diary-archive.js';
import { handleUpdate } from '../src/bot/handlers.js';
import { runBot } from '../src/bot/bot.js';
import { atomicWriteJson, readJson, exists } from '../src/util/atomic-write.js';
import { withLock } from '../src/util/lock.js';

// Every provider and all diary content in this file are synthetic.
async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'health-diary-multi-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let instant = new Date('2026-09-09T12:00:00Z');
  const config = { dataDir, timezone: 'Europe/London', adminUserId: 202,
    diaryUsers: [{ telegramUserId: 101, label: 'Alex' }, { telegramUserId: 202, label: 'Sam' }],
    googleDriveRootFolderId: 'root', transcriptionModel: 'fixture', entrySummaryModel: 'fixture', dailySummaryModel: 'fixture',
    immediateAttempts: 1, retryBaseMs: 0, retryIntervalMs: 0, retainLocalAudio: true };
  const sent = [], files = new Map(), objects = new Map(), sheets = new Map(), summaries = [], faults = new Set();
  async function ensure(parent, name, id) {
    if (id) {
      const found = [...objects.values()].find(object => object.id === id);
      assert.ok(found && found.parent === parent && found.name === name);
      return found;
    }
    const key = `${parent}/${name}`;
    if (!objects.has(key)) objects.set(key, { id: `object-${objects.size}`, parent, name });
    return objects.get(key);
  }
  const services = {
    telegram: {
      removeKeyboard: async () => {},
      answerCallbackQuery: async () => {},
      downloadVoice: async id => Buffer.from(`Synthetic source ${id}.`),
      sendMessage: async (chatId, text, options = {}) => {
        sent.push({ chatId, text: `${options.prefix || ''}${text}`, options });
        return { message_id: sent.length };
      },
    },
    openai: {
      transcribe: async path => readFile(path, 'utf8'),
      summarizeEntry: async text => `Entry summary: ${text}`,
      summarizeDay: async (sources, options) => {
        summaries.push({ sources, options });
        return `Daily summary: ${sources.map(source => source.transcript).join(' ')}`;
      },
    },
    drive: {
      ensureFolder: ensure, ensureSpreadsheet: ensure,
      putFile: async ({ parentId, name, path, fileId }) => {
        const key = `${parentId}/${name}`;
        const saved = files.get(key);
        if (fileId) assert.equal(fileId, saved?.id);
        const id = saved?.id ?? `file-${files.size}`;
        files.set(key, { id, parentId, name, content: await readFile(path, 'utf8') });
        return { id, webViewLink: `https://example.invalid/${id}` };
      },
    },
  };
  const sheetsFactory = scoped => {
    const id = scoped.googleSheetId;
    if (!sheets.has(id)) sheets.set(id, { entries: new Map(), days: new Map() });
    return {
      upsertEntry: async row => { sheets.get(id).entries.set(row.entryId, row); return { row: 2 }; },
      upsertDay: async row => { sheets.get(id).days.set(row.date, row); return { row: 2 }; },
    };
  };
  services.forDiary = scoped => ({ ...services,
    ...createDiaryArchive(scoped, { drive: services.drive, sheetsFactory }),
    openai: { ...services.openai, transcribe: async path => {
      if (faults.has(scoped.diaryUserId)) throw Object.assign(new Error('Synthetic failure'), { status: 503 });
      return services.openai.transcribe(path);
    } },
  });
  const now = () => new Date(instant);
  const options = { config, services, now, sleep: async () => {} };
  const { app } = await createRuntime(options);
  const userPath = (id, ...parts) => join(dataDir, 'users', String(id), ...parts);
  const voice = (id, number = 1, at = instant) => ({ from: { id }, chat: { id, type: 'private' }, message_id: number,
    date: Math.floor(new Date(at).getTime() / 1000), voice: { file_id: `voice-${id}-${number}` } });
  return { app, config, services, now, options, userPath, voice, sent, files, objects, sheets, summaries, faults,
    setNow: value => { instant = new Date(value); } };
}

test('same entry IDs in different chats retain separate sources, Drive folders, Sheets and acknowledgements', async t => {
  const f = await fixture(t);
  assert.equal(f.objects.size, 0, 'initialization must not contact Drive');
  const first = await handleUpdate({ message: f.voice(101) }, { ...f, process: false });
  const second = await handleUpdate({ message: f.voice(202) }, { ...f, process: false });
  assert.equal(first.entry_id, second.entry_id);
  assert.equal(f.objects.size, 0, 'receipts must not depend on Drive');
  await f.app.processEntry(first.entry_id, 101);
  await f.app.processEntry(second.entry_id, 202);
  for (const id of [101, 202]) {
    const path = f.userPath(id, 'entries', first.date, first.entry_id);
    assert.equal(await readFile(join(path, 'transcript.md'), 'utf8'), `Synthetic source voice-${id}-1.`);
    const meta = await readJson(join(path, 'metadata.json'));
    assert.ok(Object.values(meta.steps).every(step => step.status === 'complete'));
    const binding = await readJson(f.userPath(id, 'archive.json'));
    assert.equal(binding.telegram_user_id, id);
    assert.match(f.sheets.get(binding.spreadsheet_id).entries.get(first.entry_id).summary, new RegExp(`voice-${id}-1`));
    assert.match(f.sent.find(message => message.chatId === id).text, new RegExp(`voice-${id}-1`));
    assert.ok(f.objects.has(`root/${id}`));
  }
  assert.equal(f.sheets.size, 2);
  const restart = await createMultiDiary(f.options);
  await restart.retry();
  assert.equal(f.sent.filter(message => message.text.startsWith('Recorded')).length, 2);
  assert.equal(f.sheets.size, 2);
  assert.ok(![...f.files.values()].some(file => file.name.startsWith('all-')), 'ordinary processing must not generate exports');
});

test('bot backlog preserves both owners even when entry IDs collide and shares one durable cursor', async t => {
  const f = await fixture(t);
  const batches = [[101, 202].map((id, index) => ({ update_id: index + 8, message: f.voice(id) })), []];
  f.services.telegram.getUpdates = async () => batches.shift() ?? [];
  await runBot({ ...f, maxCycles: 1, recoverOnStart: false, logger: () => {} });
  assert.equal(f.sent.filter(message => message.text.startsWith('Recorded')).length, 2);
  assert.equal((await readJson(join(f.config.dataDir, 'telegram.json'))).next_offset, 10);
  const cursors = [];
  f.services.telegram.getUpdates = async ({ offset }) => { cursors.push(offset); return []; };
  const app = await createMultiDiary(f.options);
  await runBot({ ...f, app, maxCycles: 1, logger: () => {} });
  assert.deepEqual(cursors, [10, 10]);
  assert.equal(f.sent.filter(message => message.text.startsWith('Recorded')).length, 2);
});

test('commands cannot use an implicit diary and voice membership is independent of admin status', async t => {
  const f = await fixture(t);
  for (const id of [101, 202]) for (const text of ['/today', '/last', '/day 2026-09-09', '/status', '/retry', '/export']) {
    await handleUpdate({ message: { ...f.voice(id), voice: undefined, text } }, f);
    assert.match(f.sent.at(-1).text, id === 101 ? /voice notes/ : /Choose a diary/);
  }
  await assert.rejects(f.app.lastDay(), { code: 'CONFIGURATION_ERROR' });
  await assert.rejects(f.app.exportAggregates(), { code: 'CONFIGURATION_ERROR' });
  await assert.rejects(f.app.forUser('../101'), { code: 'CONFIGURATION_ERROR' });
  for (const message of [f.voice(303), { ...f.voice(202), chat: { type: 'group', id: -1 } },
    { ...f.voice(202), from: { id: 202, is_bot: true } }]) assert.equal(await handleUpdate({ message }, f), null);
  assert.equal(f.objects.size, 0);
  assert.equal(await exists(f.userPath(303)), false);
});

test('visual admin selection reads and exports the chosen real diary while admin voice stays in their own', async t => {
  const f = await fixture(t);
  for (const id of [101, 202]) await handleUpdate({ message: f.voice(id) }, f);
  const send = text => handleUpdate({ message: { ...f.voice(202), voice: undefined, text } }, f);
  const tap = async text => {
    const menu = f.sent.at(-1);
    const button = menu.options.replyMarkup.inline_keyboard.flat().find(button => button.text === text);
    assert.ok(button);
    await handleUpdate({ callback_query: { id: `fixture-${f.sent.length}`, data: button.callback_data, from: { id: 202 },
      message: { message_id: f.sent.length, date: 1_783_589_600, chat: { id: 202, type: 'private' } } } }, f);
  };
  await send('/admin');
  await tap('Alex (101)');
  await tap('Latest day');
  assert.match(f.sent.at(-1).text, /^Diary: Alex \(101\)/);
  assert.match(f.sent.at(-1).text, /voice-101-1/);
  assert.doesNotMatch(f.sent.at(-1).text, /voice-202/);
  await handleUpdate({ message: f.voice(202, 2) }, f);
  await send('/today');
  assert.match(f.sent.at(-1).text, /^Diary: Alex \(101\)/);
  assert.match(f.sent.at(-1).text, /Number of entries so far: 1/);
  await tap('Export');
  assert.match(f.sent.at(-1).text, /Export ready/);
  assert.match(await readFile(f.userPath(101, 'aggregates', 'all-transcripts.md'), 'utf8'), /voice-101-1/);
  assert.equal(await exists(f.userPath(202, 'aggregates', 'all-transcripts.md')), false);
  await tap('Switch person');
  await tap('Sam (202)');
  await tap('Latest day');
  assert.match(f.sent.at(-1).text, /^Diary: Sam \(202\)/);
  assert.match(f.sent.at(-1).text, /voice-202-2/);
  assert.doesNotMatch(f.sent.at(-1).text, /voice-101/);
});

test('reminders and daily summaries use only their owners records; exports remain on demand', async t => {
  const f = await fixture(t);
  await handleUpdate({ message: f.voice(101) }, f);
  f.setNow('2026-09-09T21:30:00Z');
  await f.app.recordPoll();
  await f.app.reminder();
  await f.app.reminder();
  const reminders = f.sent.filter(message => message.text.startsWith("You haven't"));
  assert.deepEqual(reminders.map(message => message.chatId), [202]);
  await handleUpdate({ message: f.voice(202) }, f);
  f.setNow('2026-09-10T02:00:00Z');
  await f.app.recordPoll();
  await f.app.daily();
  assert.equal(f.summaries.length, 2);
  for (const id of [101, 202]) {
    const text = await f.app.showDay('2026-09-09', id);
    assert.match(text, new RegExp(`voice-${id}-1`));
    assert.doesNotMatch(text, new RegExp(`voice-${id === 101 ? 202 : 101}-1`));
  }
  assert.ok(![...f.files.values()].some(file => file.name.startsWith('all-')));
  const exported = await f.app.exportAggregates(101);
  assert.equal(exported.uploaded, true);
  const text = await readFile(f.userPath(101, 'aggregates', 'all-transcripts.md'), 'utf8');
  assert.match(text, /voice-101-1/);
  assert.doesNotMatch(text, /voice-202-1/);
  assert.equal(await exists(f.userPath(202, 'aggregates', 'all-transcripts.md')), false);
});

test('a new diary starts when enabled; label changes and removals preserve storage identities', async t => {
  const f = await fixture(t);
  await handleUpdate({ message: f.voice(101) }, f);
  const binding = await readJson(f.userPath(101, 'archive.json'));
  f.setNow('2026-09-12T02:00:00Z');
  const config = { ...f.config, diaryUsers: [{ telegramUserId: 101, label: 'Renamed' }, { telegramUserId: 303, label: 'New' }] };
  const app = await createMultiDiary({ ...f.options, config });
  assert.equal((await readJson(f.userPath(303, 'state.json'))).start_date, '2026-09-12');
  assert.equal((await readJson(f.userPath(101, 'state.json'))).start_date, '2026-09-09');
  assert.match(await (await app.forUser(101)).status(), /Diary: Renamed \(101\)/);
  await assert.rejects(app.forUser(202), { code: 'CONFIGURATION_ERROR' });
  await app.recordPoll();
  await app.daily();
  assert.deepEqual(await readdir(f.userPath(303, 'days')), []);
  assert.deepEqual(await readJson(f.userPath(101, 'archive.json')), binding);
  assert.ok(await exists(f.userPath(202, 'state.json')));
  assert.ok(!f.objects.has('root/Renamed'));
});

test('one failed provider or damaged diary does not stop another diary retrying', async t => {
  const f = await fixture(t);
  f.faults.add(101);
  for (const id of [101, 202]) await handleUpdate({ message: f.voice(id) }, { ...f, process: false });
  const result = await f.app.retry();
  assert.equal(result.errors.length, 0);
  assert.ok(result.diaries.find(diary => diary.telegram_user_id === 101).result.retrying > 0);
  assert.ok(f.sent.some(message => message.chatId === 202 && message.text.startsWith('Recorded')));
  await atomicWriteJson(f.userPath(101, 'state.json'), { schema_version: 1, start_date: '2026-09-09', telegram_user_id: 999 });
  const second = await f.app.retry();
  assert.deepEqual([...new Set(second.errors.map(error => error.telegram_user_id))], [101]);
  assert.deepEqual(second.diaries.map(diary => diary.telegram_user_id), [202]);
  assert.match(await f.app.status(), /Diary 101: unavailable/);
  assert.ok(!f.sent.some(message => message.chatId === 999));
});

test('foreign entry and day metadata are excluded from reads, processing and exports', async t => {
  const f = await fixture(t);
  const entry = await handleUpdate({ message: f.voice(101) }, f);
  const path = ['entries', entry.date, entry.entry_id];
  await cp(f.userPath(101, ...path), f.userPath(202, ...path), { recursive: true });
  await cp(f.userPath(101, 'days', entry.date), f.userPath(202, 'days', entry.date), { recursive: true });
  const before = f.sent.length;
  await assert.rejects(f.app.processEntry(entry.entry_id, 202), /Entry not found/);
  assert.equal(f.sent.length, before);
  assert.doesNotMatch(await f.app.showDay(entry.date, 202), /voice-101/);
  assert.equal((await f.app.exportAggregates(202)).rebuilt, false);
});

test('poll health is shared and records progress while a diary writer is locked', async t => {
  const f = await fixture(t);
  await withLock(f.userPath(101), async () => {
    await f.app.recordPollFailure(Object.assign(new Error('Synthetic denial'), { status: 403 }));
    assert.equal(f.sent.filter(message => message.text.includes('needs attention')).length, 1);
    await f.app.recordPollFailure(Object.assign(new Error('Synthetic denial'), { status: 403 }));
    assert.equal(f.sent.filter(message => message.text.includes('needs attention')).length, 1);
    await f.app.recordPoll();
  });
  assert.equal(f.sent.filter(message => message.text.includes('issue resolved')).length, 1);
  const state = await readJson(join(f.config.dataDir, 'polling.json'));
  assert.equal(state.last_poll_drained_at, f.now().toISOString());
  for (const id of [101, 202]) {
    assert.match(await (await f.app.forUser(id)).status(), /Last Telegram backlog drain: 2026-09-09T12:00:00.000Z/);
    assert.equal((await readJson(f.userPath(id, 'state.json'))).steps?.telegram_poll, undefined);
  }
});

test('both storage modes refuse an incompatible layout without moving or overwriting records', async t => {
  const f = await fixture(t);
  await assert.rejects(createDiary({ config: f.config }), { code: 'CONFIGURATION_ERROR' });
  const legacy = join(f.config.dataDir, 'legacy-fixture');
  await mkdir(join(legacy, 'entries'), { recursive: true });
  await atomicWriteJson(join(legacy, 'state.json'), { schema_version: 1, start_date: '2026-01-01' });
  await assert.rejects(createMultiDiary({ ...f.options, config: { ...f.config, dataDir: legacy } }), /requires migration/);
  assert.equal(await exists(join(legacy, 'users')), false);
  assert.equal(await exists(join(legacy, 'layout.json')), false);
  assert.equal((await readJson(join(legacy, 'state.json'))).start_date, '2026-01-01');
});

test('Drive owner labels synchronize changes only, retry independently, and never generate health exports', async t => {
  const f = await fixture(t);
  const uploads = [];
  let failOwner = null;
  const putFile = f.services.drive.putFile;
  f.services.drive.putFile = async options => {
    uploads.push(options);
    if (options.name === 'owner.txt' && options.parentId === failOwner) throw Object.assign(new Error('Synthetic Drive outage'), { status: 503 });
    return putFile(options);
  };
  assert.equal((await f.app.syncDirectory()).updated, 3);
  const firstBindings = await Promise.all([101, 202].map(id => readJson(f.userPath(id, 'archive.json'))));
  const firstIds = [...f.files.values()].map(file => file.id);
  uploads.length = 0;
  assert.equal((await f.app.syncDirectory()).updated, 0);
  assert.deepEqual(uploads, []);
  const config = { ...f.config, diaryUsers: [{ telegramUserId: 101, label: 'Renamed Alex' }, { telegramUserId: 202, label: 'Renamed Sam' }] };
  const app = await createMultiDiary({ ...f.options, config });
  failOwner = firstBindings[0].drive_folder_id;
  const failed = await app.syncDirectory();
  assert.deepEqual(failed.errors.map(error => error.telegram_user_id), [101]);
  assert.equal(failed.updated, 2);
  assert.match(await (await app.forUser(101)).status(), /drive_owner_labels/);
  assert.doesNotMatch(await (await app.forUser(202)).status(), /drive_owner_labels/);
  assert.match(f.files.get(`${firstBindings[1].drive_folder_id}/owner.txt`).content, /Renamed Sam/);
  failOwner = null;
  uploads.length = 0;
  assert.equal((await app.syncDirectory()).updated, 1);
  assert.equal(uploads.length, 1);
  assert.match(f.files.get('root/diary-users.txt').content, /101\tRenamed Alex/);
  assert.match(f.files.get(`${firstBindings[0].drive_folder_id}/owner.txt`).content, /Renamed Alex/);
  assert.deepEqual([...f.files.values()].map(file => file.id), firstIds);
  assert.deepEqual(await Promise.all([101, 202].map(id => readJson(f.userPath(id, 'archive.json')))), firstBindings);
  assert.equal(f.summaries.length, 0);
  assert.equal(f.sheets.size, 0);
  assert.equal([...f.files.values()].filter(file => file.name.startsWith('all-')).length, 0);
});
