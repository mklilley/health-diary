import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleUpdate } from '../src/bot/handlers.js';
import { commandReply, DIARY_USER_HELP } from '../src/bot/commands.js';
import { runBot } from '../src/bot/bot.js';

const config = { diaryUserId: 101, adminUserId: 202, timezone: 'Europe/London' };
const now = () => new Date('2026-06-01T23:30:00Z');
function message(userId, body = {}) {
  return { message_id: 7, date: 1_780_357_200, chat: { id: userId, type: 'private' }, from: { id: userId }, ...body };
}
function mocks() {
  const calls = [];
  return {
    calls,
    config,
    now,
    services: { telegram: { sendMessage: async (chat, text) => calls.push(['send', chat, text]) } },
    app: {
      receiveVoice: async (voice) => { calls.push(['receive', voice.message_id]); return { entry_id: `entry-${voice.message_id}` }; },
      processEntry: async (id) => calls.push(['process', id]),
      status: async () => { calls.push(['status']); return 'Operational status'; },
      retry: async (options) => { calls.push(['retry', options]); return { checked: 3, resolved: 2, retrying: 1, attention: 0 }; },
      exportAggregates: async () => {
        calls.push(['export']);
        return { rebuilt: true, uploaded: true,
          snapshot: { generated_at: '2026-06-02T00:30:00+01:00', entry_count: 2, transcript_count: 2,
            entry_summary_count: 2, daily_summary_count: 1, entries_pending: 0, due_daily_summaries_missing: 0 },
          uploads: ['all-transcripts.md', 'all-entry-summaries.md', 'all-daily-summaries.md']
            .map((name, i) => ({ name, complete: true, url: `https://drive.google.com/file/d/export-${i}/view` })),
        };
      },
      showDay: async (date) => { calls.push(['day', date]); return `Stored day ${date}`; },
      lastDay: async () => { calls.push(['last']); return 'Most recent completed day'; },
    },
  };
}

test('diary user voice creates a receipt before processing; deferred mode only creates the receipt', async () => {
  const dependencies = mocks();
  const update = { message: message(101, { voice: { file_id: 'voice-file' } }) };
  assert.deepEqual(await handleUpdate(update, dependencies), { entry_id: 'entry-7' });
  assert.deepEqual(dependencies.calls, [['receive', 7], ['process', 'entry-7']]);
  dependencies.calls.length = 0;
  await handleUpdate(update, { ...dependencies, process: false });
  assert.deepEqual(dependencies.calls, [['receive', 7]]);
});

test('diary user text and admin voice are bot interactions only', async () => {
  const dependencies = mocks();
  await handleUpdate({ message: message(101, { text: 'An ordinary message' }) }, dependencies);
  await handleUpdate({ message: message(202, { voice: { file_id: 'admin-file' } }) }, dependencies);
  assert.equal(dependencies.calls.length, 2);
  assert.ok(dependencies.calls.every(([operation]) => operation === 'send'));
  assert.match(dependencies.calls[0][2], /voice notes/);
  assert.match(dependencies.calls[1][2], /not added/);
});

test('unknown users, groups, edited messages, channels and bot senders cannot access diary data', async () => {
  const dependencies = mocks();
  const updates = [
    { message: message(303, { text: '/status' }) },
    { message: message(303, { voice: { file_id: 'other-file' } }) },
    { message: message(202, { text: '/status', chat: { id: -1, type: 'supergroup' } }) },
    { message: message(101, { voice: { file_id: 'group-file' }, chat: { id: -2, type: 'group' } }) },
    { edited_message: message(101, { voice: { file_id: 'edited-file' } }) },
    { channel_post: message(202, { text: '/status' }) },
    { message: message(202, { text: '/status', from: { id: 202, is_bot: true } }) },
    { message: message(202, { text: '/status', chat: { id: 303, type: 'private' } }) },
    { message: message(303, { text: '/export' }) },
    { message: message(202, { text: '/export', chat: { id: -1, type: 'group' } }) },
  ];
  for (const update of updates) assert.equal(await handleUpdate(update, dependencies), null);
  assert.deepEqual(dependencies.calls, []);
});

test('diary user cannot invoke any admin command, including bot-addressed commands', async () => {
  const dependencies = mocks();
  for (const text of ['/status', '/retry', '/export', '/export@DiaryBot', '/day 2026-06-01', '/today', '/yesterday', '/last', '/status@DiaryBot']) {
    await handleUpdate({ message: message(101, { text }) }, dependencies);
  }
  assert.ok(dependencies.calls.every(([operation, recipient, text]) => operation === 'send' && recipient === 101 && /voice notes/.test(text)));
  assert.equal(await commandReply('/help', { ...dependencies, role: 'diary_user' }), DIARY_USER_HELP);
  assert.equal(await commandReply('/start', { ...dependencies, role: 'diary_user' }), DIARY_USER_HELP);
  assert.doesNotMatch(DIARY_USER_HELP, /\/retry|\/status|\/day|\/export/);
});

test('admin commands use stored views, strict ISO dates and London calendar dates', async () => {
  const dependencies = mocks();
  const context = { ...dependencies, role: 'admin' };
  assert.equal(await commandReply('/status@DiaryBot', context), 'Operational status');
  assert.match(await commandReply('/retry', context), /Outstanding operations checked: 3\nResolved: 2\nStill retrying: 1\nNeeds attention: 0/);
  assert.equal(await commandReply('/day 2026-02-28', context), 'Stored day 2026-02-28');
  assert.equal(await commandReply('/today', context), 'Stored day 2026-06-02');
  assert.equal(await commandReply('/yesterday', context), 'Stored day 2026-06-01');
  assert.equal(await commandReply('/last', context), 'Most recent completed day');
  const reads = dependencies.calls.length;
  for (const text of ['/day', '/day 2026-02-30', '/day 2026-6-1', '/day ../../secret', '/day 2026-02-28 extra']) {
    assert.match(await commandReply(text, context), /valid calendar date/);
  }
  assert.equal(dependencies.calls.length, reads);
  assert.deepEqual(dependencies.calls.find(([operation]) => operation === 'retry'), ['retry', { force: true }]);
  for (const text of ['/help', '/start']) {
    const help = await commandReply(text, context);
    for (const command of ['/status', '/retry', '/export', '/day', '/today', '/yesterday', '/last', '/help']) assert.ok(help.includes(command));
  }
});

test('admin export acknowledges the request and replies with dated counts and private Drive links', async () => {
  const dependencies = mocks();
  await handleUpdate({ message: message(202, { text: '/export@DiaryBot' }) }, dependencies);
  const [ack, operation, reply] = dependencies.calls;
  assert.deepEqual(ack.slice(0, 2), ['send', 202]);
  assert.match(ack[2], /Preparing the diary export/);
  assert.deepEqual(operation, ['export']);
  assert.deepEqual(reply.slice(0, 2), ['send', 202]);
  assert.match(reply[2], /Export ready/);
  assert.match(reply[2], /Generated: 2026-06-02T00:30:00\+01:00/);
  assert.match(reply[2], /Transcripts included: 2\/2/);
  assert.match(reply[2], /Entries still processing: 0/);
  assert.equal((reply[2].match(/https:\/\/drive.google.com\/file\/d\//g) || []).length, 3);
  dependencies.calls.length = 0;
  await handleUpdate({ message: message(202, { text: '/export extra' }) }, dependencies);
  assert.equal(dependencies.calls.length, 1);
  assert.match(dependencies.calls[0][2], /without arguments/);
});

test('export replies distinguish incomplete uploads, damaged sources and unexpected failures', async () => {
  const dependencies = mocks();
  const result = await dependencies.app.exportAggregates();
  result.uploaded = false;
  result.uploads[0] = { name: 'all-transcripts.md', complete: false, url: null };
  dependencies.app.exportAggregates = async () => result;
  const partial = await commandReply('/export', { ...dependencies, role: 'admin' });
  assert.match(partial, /uploads are still pending/);
  assert.match(partial, /all-transcripts.md: upload pending/);
  assert.doesNotMatch(partial, /export-0\/view/);
  assert.match(partial, /\/status/);
  dependencies.app.exportAggregates = async () => ({ rebuilt: false });
  assert.match(await commandReply('/export', { ...dependencies, role: 'admin' }), /Existing exports were preserved/);
  dependencies.app.exportAggregates = async () => { throw new Error('Synthetic private provider detail'); };
  dependencies.calls.length = 0;
  await handleUpdate({ message: message(202, { text: '/export' }) }, dependencies);
  assert.match(dependencies.calls.at(-1)[2], /could not be completed/);
  assert.doesNotMatch(dependencies.calls.at(-1)[2], /private provider detail/);
});

test('today and yesterday stay correct over both London DST transitions', async () => {
  const dependencies = mocks();
  for (const [instant, today, yesterday] of [
    ['2026-03-29T00:30:00Z', '2026-03-29', '2026-03-28'],
    ['2026-03-29T23:30:00Z', '2026-03-30', '2026-03-29'],
    ['2026-10-25T00:30:00Z', '2026-10-25', '2026-10-24'],
    ['2026-10-25T23:30:00Z', '2026-10-25', '2026-10-24'],
  ]) {
    const context = { ...dependencies, role: 'admin', now: () => new Date(instant) };
    assert.equal(await commandReply('/today', context), `Stored day ${today}`);
    assert.equal(await commandReply('/yesterday', context), `Stored day ${yesterday}`);
  }
});

async function temporaryData(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'health-diary-bot-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

test('poller durably receives all backlog batches before recording a drain or processing commands', async (t) => {
  const dataDir = await temporaryData(t);
  const events = [];
  const batches = [
    [
      { update_id: 1, message: message(101, { message_id: 11, voice: { file_id: 'one' } }) },
      { update_id: 2, message: message(202, { text: '/status' }) },
    ],
    [{ update_id: 3, message: message(101, { message_id: 12, voice: { file_id: 'two' } }) }],
    [],
  ];
  const dependencies = mocks();
  dependencies.app.receiveVoice = async (voice) => {
    events.push(`receipt-${voice.message_id}`);
    const cursor = await readFile(join(dataDir, 'telegram.json'), 'utf8').then(JSON.parse).catch(() => ({ next_offset: 0 }));
    assert.ok(cursor.next_offset < (voice.message_id === 11 ? 2 : 4));
    return { entry_id: `entry-${voice.message_id}` };
  };
  dependencies.app.recordPoll = async () => events.push('drained');
  dependencies.app.processEntry = async (id) => events.push(`process-${id}`);
  dependencies.app.status = async () => { events.push('status'); return 'Operational status'; };
  const polls = [];
  dependencies.services.telegram.getUpdates = async (options) => { polls.push(options); return batches.shift(); };
  await runBot({ ...dependencies, config: { ...config, dataDir }, maxCycles: 1, recoverOnStart: false, logger: () => {} });
  assert.deepEqual(events, ['receipt-11', 'receipt-12', 'drained', 'process-entry-11', 'process-entry-12', 'status']);
  assert.deepEqual(polls.map(({ offset, timeout }) => [offset, timeout]), [[0, 30], [3, 0], [4, 0]]);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'telegram.json'), 'utf8')).next_offset, 4);
});

test('a failed receipt does not advance the durable cursor and redelivery is processed', async (t) => {
  const dataDir = await temporaryData(t);
  const dependencies = mocks();
  const update = { update_id: 40, message: message(101, { voice: { file_id: 'retry-file' } }) };
  const polls = [];
  let attempts = 0;
  dependencies.app.receiveVoice = async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('Disk temporarily unavailable'), { code: 'EIO' });
    return { entry_id: 'entry-7' };
  };
  dependencies.app.recordPoll = async () => {};
  dependencies.services.telegram.getUpdates = async ({ offset, timeout }) => {
    polls.push([offset, timeout]);
    return offset === 0 ? [update] : [];
  };
  const waits = [];
  await runBot({ ...dependencies, config: { ...config, dataDir }, maxCycles: 1, recoverOnStart: false, sleep: async (ms) => waits.push(ms), logger: () => {} });
  assert.deepEqual(polls, [[0, 30], [0, 30], [41, 0]]);
  assert.deepEqual(waits, [1000]);
  assert.equal(attempts, 2);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'telegram.json'), 'utf8')).next_offset, 41);
});

test('restart resumes the stored offset and invokes recovery only after a confirmed drain', async (t) => {
  const dataDir = await temporaryData(t);
  const dependencies = mocks();
  dependencies.app.recordPoll = async () => dependencies.calls.push(['drained']);
  const update = { update_id: 70, message: message(101, { voice: { file_id: 'persisted-file' } }) };
  let batches = [[update], []];
  dependencies.services.telegram.getUpdates = async () => batches.shift();
  await runBot({ ...dependencies, config: { ...config, dataDir }, maxCycles: 1, recoverOnStart: false, logger: () => {} });
  dependencies.calls.length = 0;
  const offsets = [];
  batches = [[], []];
  dependencies.services.telegram.getUpdates = async ({ offset }) => { offsets.push(offset); return batches.shift(); };
  await runBot({ ...dependencies, config: { ...config, dataDir }, maxCycles: 1, logger: () => {} });
  assert.deepEqual(offsets, [71, 71]);
  assert.deepEqual(dependencies.calls, [['drained'], ['retry', undefined]]);
});

test('graceful stop aborts a long poll and leaves the poller lease available', async (t) => {
  const dataDir = await temporaryData(t);
  const dependencies = mocks();
  const controller = new AbortController();
  dependencies.services.telegram.getUpdates = async ({ signal }) => {
    controller.abort();
    signal.throwIfAborted();
  };
  await runBot({ ...dependencies, config: { ...config, dataDir }, signal: controller.signal, logger: () => {} });
  // A second invocation can immediately acquire the same poller lease.
  await runBot({ ...dependencies, config: { ...config, dataDir }, maxCycles: 0, logger: () => {} });
  assert.deepEqual(dependencies.calls, []);
});
