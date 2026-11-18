import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { atomicWriteJson, readJson } from '../src/util/atomic-write.js';
import { createTelegramService } from '../src/services/telegram.js';
import { createOpenAIService } from '../src/services/openai.js';
import { createDriveService, FOLDER_MIME, SHEET_MIME } from '../src/services/google-drive.js';
import { createDiaryArchive } from '../src/services/diary-archive.js';
import { createSheetsService, ENTRY_HEADERS, DAY_HEADERS } from '../src/services/google-sheets.js';
import { safeServiceError } from '../src/services/errors.js';
import { safeError } from '../src/util/logging.js';
import { loadGoogleAuth, makeGoogleAuth } from '../src/services/google-auth.js';
import { validOAuthState, provisionGoogleArchive } from '../src/jobs/google-auth.js';
import { prompt as entryPrompt, version as entryVersion } from '../src/prompts/entry-summary-v1.js';
import { prompt as dayPrompt, version as dayVersion } from '../src/prompts/daily-summary-v1.js';
import { prompt as transcriptionPrompt } from '../src/prompts/transcription-v2.js';

const config = { httpTimeoutMs: 1000, telegramBotToken: 'not-a-real-token', googleSheetId: 'sheet-test', transcriptionModel: 'audio-model', entrySummaryModel: 'entry-model', dailySummaryModel: 'day-model' };
async function fileFixture(t, bytes = Buffer.from('OggS synthetic fixture')) {
  const dir = await mkdtemp(join(tmpdir(), 'health-services-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'audio.ogg');
  await writeFile(path, bytes);
  return { dir, path, bytes };
}
const json = (result) => new Response(JSON.stringify({ ok: true, result }), { headers: { 'content-type': 'application/json' } });

test('Telegram keeps original bytes and never interprets summary text as markup', async () => {
  const calls = [];
  const bytes = Buffer.from('OggS original fixture');
  const telegram = createTelegramService(config, { fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/getFile')) return json({ file_path: 'voice/file_1.oga', file_size: bytes.length });
    if (url.includes('/file/bot')) return new Response(bytes);
    return json({ message_id: 12 });
  } });
  assert.deepEqual(await telegram.downloadVoice('file-one'), bytes);
  await telegram.sendMessage(1001, 'Recorded ✓\n\nExact <text> *text*.');
  const body = JSON.parse(calls[2].options.body);
  assert.equal(body.text, 'Recorded ✓\n\nExact <text> *text*.');
  assert.equal(body.parse_mode, undefined);
  assert.equal(body.link_preview_options.is_disabled, true);
});

test('Telegram download rejects partial bytes and unsafe file paths', async () => {
  const partial = createTelegramService(config, { fetchImpl: async (url) => url.endsWith('/getFile')
    ? json({ file_path: 'voice/file.oga', file_size: 10 }) : new Response('short') });
  await assert.rejects(partial.downloadVoice('file'), { code: 'INCOMPLETE_AUDIO' });
  const unsafe = createTelegramService(config, { fetchImpl: async () => json({ file_path: '../secret' }) });
  await assert.rejects(unsafe.downloadVoice('file'), { code: 'INVALID_FILE_PATH' });
});

test('Telegram splits long output without splitting a surrogate pair', async () => {
  const bodies = [];
  const telegram = createTelegramService(config, { fetchImpl: async (_, options) => {
    bodies.push(JSON.parse(options.body));
    return json({ message_id: bodies.length });
  } });
  const text = `${'x'.repeat(4095)}😀end`;
  const result = await telegram.sendMessage(1, text);
  assert.equal(bodies.length, 2);
  assert.equal(bodies.map((body) => body.text).join(''), text);
  assert.equal(bodies[0].text.length, 4095);
  assert.deepEqual(result.message_ids, [1, 2]);
});

test('Telegram repeats diary identification on every chunk and attaches buttons only to the last', async () => {
  const bodies = [];
  const telegram = createTelegramService(config, { fetchImpl: async (_, options) => {
    bodies.push(JSON.parse(options.body));
    return json({ message_id: bodies.length });
  } });
  const prefix = 'Diary: Alex <fixture> (101)\n\n';
  const text = `${'x'.repeat(4095 - prefix.length)}😀${'y'.repeat(6000)}`;
  const replyMarkup = { inline_keyboard: [[{ text: 'Today', callback_data: 'fixture' }]] };
  const result = await telegram.sendMessage(202, text, { prefix, replyMarkup });
  assert.equal(bodies.length, 3);
  assert.ok(bodies.every(body => body.text.startsWith(prefix) && body.text.length <= 4096 && body.parse_mode === undefined));
  assert.equal(bodies.map(body => body.text.slice(prefix.length)).join(''), text);
  assert.ok(bodies.slice(0, -1).every(body => body.reply_markup === undefined));
  assert.deepEqual(bodies.at(-1).reply_markup, replyMarkup);
  assert.equal(result.message_id, 3);
});

test('Telegram scopes deletion to diary users and admin controls to the admin private chat', async () => {
  const calls = [];
  const telegram = createTelegramService(config, { fetchImpl: async (url, options) => {
    calls.push({ method: url.split('/').at(-1), body: JSON.parse(options.body) });
    return json(url.endsWith('/getUpdates') ? [] : true);
  } });
  await telegram.getUpdates({ offset: 20, timeout: 0 });
  await telegram.answerCallbackQuery('query-1');
  await telegram.removeKeyboard(202, 7);
  await telegram.setCommands(202, { admin: true, diary: true });
  await telegram.setCommands(101, { diary: true });
  await telegram.setCommands(303, { admin: true });
  assert.deepEqual(calls[0].body, { offset: 20, timeout: 0, allowed_updates: ['message', 'callback_query'] });
  assert.deepEqual(calls[1], { method: 'answerCallbackQuery', body: { callback_query_id: 'query-1', cache_time: 0 } });
  assert.deepEqual(calls[2], { method: 'editMessageReplyMarkup', body: { chat_id: 202, message_id: 7, reply_markup: { inline_keyboard: [] } } });
  assert.equal(calls[3].method, 'setMyCommands');
  assert.deepEqual(calls[3].body.scope, { type: 'chat', chat_id: 202 });
  assert.deepEqual(calls[3].body.commands.map(command => command.command), ['delete_last', 'admin', 'cancel']);
  assert.deepEqual(calls[4].body.scope, { type: 'chat', chat_id: 101 });
  assert.deepEqual(calls[4].body.commands.map(command => command.command), ['delete_last', 'help']);
  assert.deepEqual(calls[5].body.commands.map(command => command.command), ['admin', 'cancel']);
});

test('Telegram API errors retain status without secrets or raw provider descriptions', async () => {
  let calls = 0;
  const telegram = createTelegramService(config, { fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ ok: false, error_code: 429, description: 'confidential-provider-body', parameters: { retry_after: 30 } }), { status: 429 });
  } });
  await assert.rejects(telegram.sendMessage(1, 'fixture'), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterSeconds, 30);
    assert.ok(!JSON.stringify(error).includes('confidential'));
    assert.ok(!error.message.includes('not-a-real-token'));
    return true;
  });
  assert.equal(calls, 1, 'no hidden API retries');
});

test('Telegram fetch failures retain safe connection codes without exposing their nested causes', async () => {
  for (const code of ['ECONNRESET', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'EPIPE', 'synthetic-private-code']) {
    const telegram = createTelegramService(config, { fetchImpl: async () => {
      const cause = Object.assign(new Error('synthetic-private-provider-detail'), { code, url: 'synthetic-private-url' });
      throw new TypeError('synthetic-private-fetch-detail', { cause });
    } });
    await assert.rejects(telegram.getUpdates(), error => {
      const known = code !== 'synthetic-private-code';
      assert.equal(error.code, known ? code : 'REQUEST_FAILED');
      assert.equal(safeError(error).code, error.code);
      assert.equal(safeError(error).type, known ? 'network' : 'operation');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)} ${JSON.stringify(safeError(error))}`, /synthetic-private/);
      return true;
    });
  }
});

test('OpenAI uploads OGG unchanged and uses configured versions and full ordered transcripts', async (t) => {
  const fixture = await fileFixture(t);
  const requests = [];
  const client = {
    audio: { transcriptions: { create: async (request) => {
      const chunks = [];
      for await (const chunk of request.file) chunks.push(chunk);
      assert.deepEqual(Buffer.concat(chunks), fixture.bytes);
      assert.equal(request.model, 'audio-model');
      assert.equal(request.response_format, 'json');
      assert.equal(request.prompt, undefined);
      assert.equal(request.keywords, undefined);
      return { text: 'Source fixture.' };
    } } },
    responses: { create: async (request) => { requests.push(request); return { status: 'completed', output_text: 'Summary fixture.' }; } },
  };
  const openai = createOpenAIService(config, { client });
  assert.equal(await openai.transcribe(fixture.path), 'Source fixture.');
  assert.equal(await openai.summarizeEntry('Source fixture.'), 'Summary fixture.');
  await openai.summarizeDay([
    { received_at: '2026-09-09T14:00:00+01:00', entry_id: 'later', transcript: 'Full later source, not entry summary.' },
    { received_at: '2026-09-09T09:00:00+01:00', entry_id: 'earlier', transcript: 'Full earlier source.' },
  ], { date: '2026-09-09' });
  assert.equal(requests[0].instructions, entryPrompt);
  assert.equal(requests[0].store, false);
  assert.equal(requests[1].model, 'day-model');
  const dayInput = JSON.parse(requests[1].input);
  assert.deepEqual(dayInput.transcripts.map((entry) => entry.entry_id), ['earlier', 'later']);
  assert.equal(dayInput.transcripts[1].transcript, 'Full later source, not entry summary.');
});

test('OpenAI SDK sends vocabulary hints as multipart fields and honors saved transcription settings', async t => {
  const fixture = await fileFixture(t);
  const requests = [];
  const transcript = 'I ate Quorn with a Q, then corn with a C.';
  const client = new OpenAI({ apiKey: 'test-only', maxRetries: 0, fetch: async (url, options) => {
    if (url === 'data:,') return new Response('');
    assert.equal(new URL(url).pathname, '/v1/audio/transcriptions');
    const form = await new Request(url, { ...options, duplex: 'half' }).formData();
    requests.push(form);
    assert.equal(form.get('file').name, 'audio.ogg');
    assert.deepEqual(Buffer.from(await form.get('file').arrayBuffer()), fixture.bytes);
    assert.equal(form.get('response_format'), 'json');
    assert.equal(form.has('original_format'), false);
    assert.equal(form.has('language'), false);
    return new Response(JSON.stringify({ text: transcript, languages: [{ code: 'en' }] }), {
      headers: { 'content-type': 'application/json' },
    });
  } });
  const openai = createOpenAIService({ ...config, transcriptionModel: 'gpt-transcribe' }, { client });
  assert.equal(await openai.transcribe(fixture.path), transcript);
  assert.equal(requests[0].get('model'), 'gpt-transcribe');
  assert.equal(requests[0].get('prompt'), transcriptionPrompt);
  assert.deepEqual(requests[0].getAll('keywords[]'), ['Quorn', 'corn']);

  await openai.transcribe(fixture.path, { model: 'gpt-4o-transcribe' });
  assert.equal(requests[1].get('model'), 'gpt-4o-transcribe');
  assert.equal(requests[1].has('prompt'), false);
  assert.equal(requests[1].has('keywords[]'), false);

  // Entries received before vocabulary hints retain their original unprompted request.
  await openai.transcribe(fixture.path, { configuration: {
    response_format: 'json', original_format: 'ogg/opus', language: 'auto', prompt: null,
  } });
  assert.equal(requests[2].get('model'), 'gpt-transcribe');
  assert.equal(requests[2].has('prompt'), false);
  assert.equal(requests[2].has('keywords[]'), false);

  await openai.transcribe(fixture.path, { configuration: {
    response_format: 'json', prompt: 'Previously saved food vocabulary.', keywords: ['Quorn'],
  } });
  assert.equal(requests[3].get('prompt'), 'Previously saved food vocabulary.');
  assert.deepEqual(requests[3].getAll('keywords[]'), ['Quorn']);
});

test('OpenAI rejects incomplete, refused and empty summaries', async () => {
  for (const result of [
    { status: 'incomplete', output_text: 'Partial.' },
    { status: 'completed', output_text: '' },
    { status: 'completed', output_text: 'Refusal.', output: [{ content: [{ type: 'refusal' }] }] },
  ]) {
    const openai = createOpenAIService(config, { client: { responses: { create: async () => result } } });
    await assert.rejects(openai.summarizeEntry('Source fixture.'));
  }
});

function driveMock() {
  const objects = [];
  let creates = 0;
  let updates = 0;
  let loseNextCreate = false;
  let loseNextDelete = false;
  const client = { files: {
    delete: async ({ fileId }, options) => {
      assert.equal(options.retry, false);
      if (!objects.some(file => file.id === fileId)) throw Object.assign(new Error('Missing'), { code: 404 });
      const remove = id => {
        for (const child of objects.filter(file => file.parents?.includes(id))) remove(child.id);
        const index = objects.findIndex(file => file.id === id);
        if (index >= 0) objects.splice(index, 1);
      };
      remove(fileId);
      if (loseNextDelete) { loseNextDelete = false; throw Object.assign(new Error('Lost delete response'), { code: 'ECONNRESET' }); }
      return { data: {} };
    },
    list: async (request, options) => {
      assert.equal(options.retry, false);
      const parent = request.q.match(/^'([^']+)'/)[1];
      const name = request.q.match(/name = '([^']+)'/)[1];
      return { data: { files: objects.filter((file) => file.name === name && file.parents.includes(parent)) } };
    },
    get: async ({ fileId }) => ({ data: objects.find((file) => file.id === fileId) }),
    create: async ({ requestBody, media }) => {
      creates++;
      const file = { id: `file-${creates}`, ...requestBody };
      if (media) {
        const chunks = [];
        for await (const chunk of media.body) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        file.md5Checksum = createHash('md5').update(bytes).digest('hex'); file.size = String(bytes.length);
      }
      objects.push(file);
      if (loseNextCreate) { loseNextCreate = false; throw Object.assign(new Error('private raw request'), { code: 'ECONNRESET' }); }
      return { data: file };
    },
    update: async ({ fileId, media }) => {
      updates++;
      const file = objects.find((item) => item.id === fileId);
      const chunks = [];
      for await (const chunk of media.body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      file.md5Checksum = createHash('md5').update(bytes).digest('hex'); file.size = String(bytes.length);
      return { data: file };
    },
  } };
  return { client, objects, get creates() { return creates; }, get updates() { return updates; },
    loseCreate: () => { loseNextCreate = true; }, loseDelete: () => { loseNextDelete = true; } };
}

test('Drive finds folders after ambiguous create and never makes blind duplicates', async () => {
  const mock = driveMock();
  const drive = createDriveService(config, { client: mock.client });
  mock.loseCreate();
  await assert.rejects(drive.ensureFolder('parent', 'entries'), { code: 'ECONNRESET' });
  assert.deepEqual(await drive.ensureFolder('parent', 'entries'), { id: 'file-1' });
  assert.equal(mock.creates, 1);
  assert.equal(mock.objects[0].mimeType, FOLDER_MIME);
});

test('diary archive provisioning recovers interrupted creates and preserves folder and Sheet IDs', async t => {
  const { dir } = await fileFixture(t);
  const mock = driveMock();
  const drive = createDriveService(config, { client: mock.client });
  const scoped = { ...config, dataDir: dir, diaryUserId: 101, diaryLabel: 'Alex', googleDriveRootFolderId: 'root' };
  const ids = [];
  const dependencies = { drive, sheetsFactory: config => ({ ensureTabs: async () => ids.push(config.googleSheetId) }) };
  let services = createDiaryArchive(scoped, dependencies);
  assert.equal(mock.creates, 0);
  mock.loseCreate();
  await assert.rejects(services.archive.rootFolder(), { code: 'ECONNRESET' });
  assert.equal(await services.archive.rootFolder(), 'file-1');
  mock.loseCreate();
  await assert.rejects(services.sheets.ensureTabs(), { code: 'ECONNRESET' });
  services = createDiaryArchive({ ...scoped, diaryLabel: 'Renamed' }, dependencies);
  await services.sheets.ensureTabs();
  await services.sheets.ensureTabs();
  assert.equal(mock.creates, 2);
  assert.deepEqual(ids, ['file-2', 'file-2']);
  assert.deepEqual(mock.objects.map(file => [file.name, file.mimeType, file.parents]), [
    ['101', FOLDER_MIME, ['root']], ['Diary Index', SHEET_MIME, ['file-1']],
  ]);
  const path = join(dir, 'archive.json');
  const binding = await readJson(path);
  assert.equal(binding.spreadsheet_id, 'file-2');
  await assert.rejects(createDiaryArchive({ ...scoped, googleDriveRootFolderId: 'changed-root' }, dependencies).archive.rootFolder(), { code: 'DIARY_ARCHIVE_INVALID' });
  await atomicWriteJson(path, { ...binding, telegram_user_id: 202 });
  await assert.rejects(services.archive.rootFolder(), { code: 'DIARY_ARCHIVE_INVALID' });
  await atomicWriteJson(path, binding);
  mock.objects[1].parents = ['other-diary'];
  await assert.rejects(services.sheets.ensureTabs(), { code: 'REMOTE_OBJECT_CONFLICT' });
  mock.objects.length = 0;
  await assert.rejects(services.archive.rootFolder(), { code: 'REMOTE_OBJECT_CONFLICT' });
  assert.equal(mock.creates, 2, 'persisted IDs must never be silently replaced');
});

test('multi-user Google setup prepares the private root without creating a shared index', async () => {
  let reads = 0;
  const client = { files: { get: async () => {
    reads++;
    return { data: { id: 'root', mimeType: FOLDER_MIME, permissions: [{ type: 'user', role: 'owner' }] } };
  } } };
  assert.deepEqual(await provisionGoogleArchive({ ...config, googleDriveRootFolderId: 'root', diaryUsers: [] }, {}, {
    client, sheetsFactory: () => assert.fail('No shared Sheet should be created'),
  }), { rootId: 'root' });
  assert.equal(reads, 1);
});

test('Drive recovers an ambiguous upload by matching original checksum and size', async (t) => {
  const { path } = await fileFixture(t);
  const mock = driveMock();
  const drive = createDriveService(config, { client: mock.client });
  const request = { parentId: 'parent', name: 'audio.ogg', path, mimeType: 'audio/ogg' };
  mock.loseCreate();
  await assert.rejects(drive.putFile(request));
  const recovered = await drive.putFile(request);
  assert.equal(recovered.id, 'file-1');
  assert.equal(mock.creates, 1);
  assert.equal(mock.updates, 0);
  await writeFile(path, 'different original');
  await assert.rejects(drive.putFile({ ...request, fileId: recovered.id }), { code: 'IMMUTABLE_CONTENT_CONFLICT' });
  assert.equal(mock.updates, 0);
});

test('Drive mutable metadata keeps the existing file ID', async (t) => {
  const { path } = await fileFixture(t);
  const mock = driveMock();
  const drive = createDriveService(config, { client: mock.client });
  const request = { parentId: 'parent', name: 'metadata.json', path, mimeType: 'application/json', mutable: true };
  const first = await drive.putFile(request);
  await writeFile(path, 'changed metadata fixture');
  const second = await drive.putFile({ ...request, fileId: first.id });
  assert.equal(first.id, second.id);
  assert.equal(mock.creates, 1);
  assert.equal(mock.updates, 1);
});

test('Drive refuses duplicate names and never silently replaces a conflicting target', async (t) => {
  const { path } = await fileFixture(t);
  const mock = driveMock();
  mock.objects.push({ id: 'one', name: 'audio.ogg', parents: ['parent'] }, { id: 'two', name: 'audio.ogg', parents: ['parent'] });
  const drive = createDriveService(config, { client: mock.client });
  await assert.rejects(drive.putFile({ parentId: 'parent', name: 'audio.ogg', path, mimeType: 'audio/ogg' }), { code: 'DUPLICATE_REMOTE_OBJECT' });
  assert.equal(mock.creates, 0);
});

test('Drive deletes only the verified entry folder and survives a lost delete response', async t => {
  const { path } = await fileFixture(t);
  const mock = driveMock();
  const drive = createDriveService(config, { client: mock.client });
  const entries = await drive.ensureFolder('diary-101', 'entries');
  const day = await drive.ensureFolder(entries.id, '2026-09-09');
  const target = await drive.ensureFolder(day.id, 'entry-to-delete');
  const sibling = await drive.ensureFolder(day.id, 'entry-to-keep');
  for (const name of ['audio.ogg', 'transcript.md', 'summary.md', 'metadata.json']) {
    await drive.putFile({ parentId: target.id, name, path, mimeType: 'text/plain' });
  }
  const request = { rootFolderId: 'diary-101', date: '2026-09-09', entryId: 'entry-to-delete', folderId: target.id };
  await assert.rejects(drive.deleteEntryFolder({ ...request, rootFolderId: 'diary-202' }), { code: 'REMOTE_OBJECT_CONFLICT' });
  assert.ok(mock.objects.some(file => file.id === target.id));
  mock.loseDelete();
  await assert.rejects(drive.deleteEntryFolder(request), { code: 'ECONNRESET' });
  await drive.deleteEntryFolder(request);
  assert.deepEqual(mock.objects.map(file => file.id), [entries.id, day.id, sibling.id]);
  const deletes = [];
  mock.client.files.get = async () => { throw Object.assign(new Error('Not found'), { response: { status: 404 } }); };
  mock.client.files.delete = async args => { deletes.push(args); };
  await drive.deleteEntryFolder(request);
  assert.deepEqual(deletes, []);
});

test('Drive finds an entry after an ambiguous folder create without provisioning during deletion', async () => {
  const mock = driveMock();
  const drive = createDriveService(config, { client: mock.client });
  const entries = await drive.ensureFolder('root', 'entries');
  const day = await drive.ensureFolder(entries.id, '2026-09-09');
  mock.loseCreate();
  await assert.rejects(drive.ensureFolder(day.id, 'entry'), { code: 'ECONNRESET' });
  const creates = mock.creates;
  await drive.deleteEntryFolder({ rootFolderId: 'root', date: '2026-09-09', entryId: 'entry' });
  await drive.deleteEntryFolder({ rootFolderId: 'never-created', date: '2026-09-09', entryId: 'entry' });
  assert.equal(mock.creates, creates);
  assert.equal(mock.objects.length, 2);
});

test('archive deletion uses the owner’s existing Sheet and never provisions a missing archive', async t => {
  const { dir } = await fileFixture(t);
  const mock = driveMock();
  const drive = createDriveService(config, { client: mock.client });
  const calls = [];
  const scoped = { ...config, dataDir: dir, diaryUserId: 101, googleDriveRootFolderId: 'root' };
  const services = createDiaryArchive(scoped, { drive, sheetsFactory: c => ({
    ensureTabs: async () => {}, deleteEntry: async entryId => calls.push([c.googleSheetId, entryId]),
  }) });
  assert.equal(await services.archive.existingRootFolder(), null);
  await services.sheets.deleteEntry('entry');
  assert.equal(mock.creates, 0);
  await services.sheets.ensureTabs();
  const binding = await readJson(join(dir, 'archive.json'));
  await services.sheets.deleteEntry('entry');
  assert.deepEqual(calls, [[binding.spreadsheet_id, 'entry']]);
  assert.equal(mock.creates, 2);
  mock.objects.find(file => file.id === binding.spreadsheet_id).parents = ['other-owner'];
  await assert.rejects(services.sheets.deleteEntry('entry'), { code: 'REMOTE_OBJECT_CONFLICT' });
  assert.equal(calls.length, 1);
});

function sheetsMock() {
  const tabs = {};
  let appends = 0;
  let updates = 0;
  let loseNextAppend = false;
  let loseNextDelete = false;
  const tabName = (range) => range.match(/^'([^']+)'/)[1];
  const client = { spreadsheets: {
    get: async () => ({ data: { sheets: Object.keys(tabs).map((title, sheetId) => ({ properties: { title, sheetId } })) } }),
    batchUpdate: async ({ requestBody }) => {
      for (const request of requestBody.requests) {
        if (request.addSheet) tabs[request.addSheet.properties.title] = [];
        if (request.deleteDimension) {
          const { sheetId, dimension, startIndex, endIndex } = request.deleteDimension.range;
          assert.equal(dimension, 'ROWS');
          tabs[Object.keys(tabs)[sheetId]].splice(startIndex, endIndex - startIndex);
          if (loseNextDelete) { loseNextDelete = false; throw Object.assign(new Error('Lost delete response'), { status: 503 }); }
        }
      }
      return { data: {} };
    },
    values: {
      get: async ({ range }) => ({ data: { values: tabs[tabName(range)] } }),
      update: async ({ range, requestBody, valueInputOption }, options) => {
        assert.equal(valueInputOption, 'RAW'); assert.equal(options.retry, false); updates++;
        const index = Number(range.match(/!A(\d+)/)[1]) - 1;
        tabs[tabName(range)][index] = [...requestBody.values[0]];
        return { data: {} };
      },
      append: async ({ range, requestBody, valueInputOption }, options) => {
        assert.equal(valueInputOption, 'RAW'); assert.equal(options.retry, false); appends++;
        tabs[tabName(range)].push([...requestBody.values[0]]);
        if (loseNextAppend) { loseNextAppend = false; throw Object.assign(new Error('private source body'), { status: 503 }); }
        return { data: { updates: { updatedRange: 'fixture' } } };
      },
    },
  } };
  return { client, tabs, get appends() { return appends; }, get updates() { return updates; },
    loseAppend: () => { loseNextAppend = true; }, loseDelete: () => { loseNextDelete = true; } };
}

test('Sheets creates exact tabs, preserves literal summary and deduplicates lost append responses', async () => {
  const mock = sheetsMock();
  const sheets = createSheetsService(config, { client: mock.client });
  const entry = { entryId: 'entry-one', receivedAt: '2026-09-09T10:00:00+01:00', summary: '=literal summary, never a formula', audioLink: 'audio-link', transcriptLink: 'transcript-link' };
  mock.loseAppend();
  await assert.rejects(sheets.upsertEntry(entry), { status: 503 });
  await sheets.upsertEntry(entry);
  assert.equal(mock.appends, 1);
  assert.deepEqual(mock.tabs.Entries[0], ENTRY_HEADERS);
  assert.equal(mock.tabs.Entries[1][2], entry.summary);
  await sheets.upsertDay({ date: '2026-09-09', summary: 'No entries recorded.', entryCount: 0 });
  await sheets.upsertDay({ date: '2026-09-09', summary: 'No entries recorded.', entryCount: 0 });
  assert.equal(mock.appends, 2);
  assert.deepEqual(mock.tabs.Days[0], DAY_HEADERS);
  assert.equal(mock.tabs.Days[1][2], 0);
});

test('Sheets repairs the existing derived row, validates headers and rejects duplicate keys', async () => {
  const mock = sheetsMock();
  const sheets = createSheetsService(config, { client: mock.client });
  const row = { date: '2026-09-09', summary: 'Summary fixture.', entryCount: 1 };
  await sheets.upsertDay(row);
  mock.tabs.Days[1][1] = 'manually changed';
  await sheets.upsertDay(row);
  assert.equal(mock.appends, 1);
  assert.equal(mock.tabs.Days[1][1], row.summary);
  mock.tabs.Days.push([...mock.tabs.Days[1]]);
  await assert.rejects(sheets.upsertDay(row), { code: 'DUPLICATE_REMOTE_KEY' });
  mock.tabs.Days[0][0] = 'Wrong heading';
  await assert.rejects(sheets.upsertDay(row), { code: 'HEADER_MISMATCH' });
});

test('Sheets deletion re-finds by entry ID after a lost response, preserving neighbouring rows and Days', async () => {
  const mock = sheetsMock();
  const sheets = createSheetsService(config, { client: mock.client });
  await sheets.deleteEntry('missing');
  assert.deepEqual(mock.tabs, {}, 'deletion should not create tabs');
  for (const id of ['before', 'remove', 'after']) await sheets.upsertEntry({ entryId: id,
    receivedAt: 'fixture', summary: `Summary ${id}`, audioLink: 'audio', transcriptLink: 'transcript' });
  await sheets.upsertDay({ date: '2026-09-09', summary: 'Daily fixture', entryCount: 3 });
  const days = structuredClone(mock.tabs.Days);
  mock.loseDelete();
  await assert.rejects(sheets.deleteEntry('remove'), { status: 503 });
  await sheets.deleteEntry('remove');
  assert.deepEqual(mock.tabs.Entries.map(row => row[0]), ['Entry ID', 'before', 'after']);
  assert.deepEqual(mock.tabs.Days, days);
  mock.tabs.Entries.push([...mock.tabs.Entries[1]]);
  await assert.rejects(sheets.deleteEntry('before'), { code: 'DUPLICATE_REMOTE_KEY' });
  mock.tabs.Entries[0][0] = 'Unexpected column';
  await assert.rejects(sheets.deleteEntry('after'), { code: 'HEADER_MISMATCH' });
});

test('versioned prompts preserve uncertainty, corrections and forbid diagnosis and causation', () => {
  assert.equal(entryVersion, '1'); assert.equal(dayVersion, '1');
  for (const prompt of [entryPrompt, dayPrompt]) {
    assert.match(prompt, /uncertainty/i);
    assert.match(prompt, /correction/i);
    assert.match(prompt, /not diagnose/i);
    assert.match(prompt, /causal|causation/i);
    assert.match(prompt, /instructions/i);
  }
});

test('error sanitization strips provider messages and request payloads', () => {
  const error = safeServiceError('provider', { message: 'confidential health fixture', code: 'unsafe token string', response: { status: 503, data: 'confidential fixture' } });
  assert.equal(error.message, 'provider operation failed: HTTP 503');
  assert.equal(error.cause, undefined);
  assert.ok(!JSON.stringify(error).includes('confidential'));
});

test('OAuth state validation rejects missing, truncated and wrong values', () => {
  assert.equal(validOAuthState('same-state', 'same-state'), true);
  assert.equal(validOAuthState(null, 'same-state'), false);
  assert.equal(validOAuthState('same', 'same-state'), false);
  assert.equal(validOAuthState('wrongvalue', 'same-state'), false);
});

test('Google unattended auth fails early for missing or invalid credential files', async (t) => {
  const { dir } = await fileFixture(t);
  const authConfig = { ...config, googleCredentialsFile: join(dir, 'client.json'), googleTokenFile: join(dir, 'token.json') };
  await assert.rejects(loadGoogleAuth(authConfig), /OAuth client JSON/);
  await writeFile(authConfig.googleCredentialsFile, JSON.stringify({ installed: { client_id: 'test-id', client_secret: 'test-secret' } }));
  await writeFile(authConfig.googleTokenFile, '{}');
  await assert.rejects(loadGoogleAuth(authConfig), /no refresh token/);
});

test('Google transport disables hidden OAuth refresh retries even when SDK enables them', async () => {
  const auth = makeGoogleAuth({ client_id: 'fixture', client_secret: 'fixture' }, config);
  const interceptors = [...auth.transporter.interceptors.request.values()];
  const request = await interceptors.at(-1).resolved({ retry: true, retryConfig: { retry: 3 } });
  assert.equal(request.retry, false);
  assert.equal(request.retryConfig.retry, 0);
  assert.equal(request.timeout, config.httpTimeoutMs);
});

test('OAuth setup refuses an archive with existing sharing permissions', async () => {
  const client = { files: { get: async () => ({ data: { id: 'root', name: 'Health Diary', mimeType: FOLDER_MIME, permissions: [{ role: 'owner', type: 'user' }, { role: 'reader', type: 'anyone' }] } }) } };
  await assert.rejects(provisionGoogleArchive({ ...config, googleDriveRootFolderId: 'root' }, {}, { client }), { code: 'ARCHIVE_MUST_BE_PRIVATE' });
});
