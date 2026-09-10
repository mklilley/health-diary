import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createTelegramService } from '../src/services/telegram.js';
import { createOpenAIService } from '../src/services/openai.js';
import { createDriveService, FOLDER_MIME } from '../src/services/google-drive.js';
import { createSheetsService, ENTRY_HEADERS, DAY_HEADERS } from '../src/services/google-sheets.js';
import { safeServiceError } from '../src/services/errors.js';
import { loadGoogleAuth, makeGoogleAuth } from '../src/services/google-auth.js';
import { validOAuthState, provisionGoogleArchive } from '../src/jobs/google-auth.js';
import { prompt as entryPrompt, version as entryVersion } from '../src/prompts/entry-summary-v1.js';
import { prompt as dayPrompt, version as dayVersion } from '../src/prompts/daily-summary-v1.js';

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
  const client = { files: {
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
  return { client, objects, get creates() { return creates; }, get updates() { return updates; }, loseCreate: () => { loseNextCreate = true; } };
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

function sheetsMock() {
  const tabs = {};
  let appends = 0;
  let updates = 0;
  let loseNextAppend = false;
  const tabName = (range) => range.match(/^'([^']+)'/)[1];
  const client = { spreadsheets: {
    get: async () => ({ data: { sheets: Object.keys(tabs).map((title) => ({ properties: { title } })) } }),
    batchUpdate: async ({ requestBody }) => { for (const request of requestBody.requests) tabs[request.addSheet.properties.title] = []; return { data: {} }; },
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
  return { client, tabs, get appends() { return appends; }, get updates() { return updates; }, loseAppend: () => { loseNextAppend = true; } };
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
