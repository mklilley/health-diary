import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleUpdate } from '../src/bot/handlers.js';
import { runBot } from '../src/bot/bot.js';
import { readJson } from '../src/util/atomic-write.js';

function fixture() {
  const config = { adminUserId: 202, diaryUsers: [{ telegramUserId: 101, label: 'Alex' }, { telegramUserId: 202, label: 'Sam' }] };
  const sent = [], calls = [], answers = [], removed = [];
  const faults = new Set();
  let instant = new Date('2026-09-09T12:00:00Z');
  let queryId = 0;
  const services = { telegram: {
    sendMessage: async (chatId, body, options = {}) => {
      if (faults.has('send')) throw new Error('Private send failure');
      const message = { chatId, body, text: `${options.prefix || ''}${body}`, options, message_id: sent.length + 1 };
      sent.push(message);
      return { message_id: message.message_id };
    },
    answerCallbackQuery: async (id, text) => { answers.push({ id, text }); if (faults.has('answer')) throw new Error('Private callback failure'); },
    removeKeyboard: async (chatId, messageId) => { removed.push({ chatId, messageId }); if (faults.has('cleanup')) throw new Error('Private cleanup failure'); },
    setAdminCommands: async id => calls.push(['commands', id]),
  } };
  const app = { multiUser: true,
    forUser: async id => {
      calls.push(['forUser', id]);
      if (faults.has(id)) throw new Error('Private diary failure with secret content');
      return {
        showDay: async date => { calls.push(['day', id, date]); return `Saved day ${date} for ${id}`; },
        lastDay: async () => { calls.push(['last', id]); return `Latest saved day for ${id}`; },
        status: async () => { calls.push(['status', id]); return `Status for ${id}`; },
        retry: async options => { calls.push(['retry', id, options]); return { checked: 3, resolved: 2, retrying: 1, attention: 0 }; },
        exportAggregates: async () => {
          calls.push(['export', id]);
          return { rebuilt: true, uploaded: true, snapshot: { generated_at: '2026-09-09T13:00:00+01:00', entry_count: 1,
            transcript_count: 1, entry_summary_count: 1, daily_summary_count: 0, entries_pending: 0, due_daily_summaries_missing: 0 },
          uploads: [{ name: 'all-transcripts.md', url: `https://example.invalid/export/${id}` }] };
        },
      };
    },
    receiveVoice: async message => { calls.push(['voice', message.from.id]); return { entry_id: 'collision' }; },
    processEntry: async (entryId, ownerId) => calls.push(['process', ownerId, entryId]),
    recordPoll: async () => calls.push(['drain']),
    retry: async () => calls.push(['globalRetry']),
    status: async () => assert.fail('Must never call installation-wide status'),
    exportAggregates: async () => assert.fail('Must never call installation-wide export'),
  };
  const now = () => new Date(instant);
  const context = { config, app, services, now };
  const message = (text, id = 202) => ({ message_id: 7, date: 1_783_589_600,
    from: { id }, chat: { id, type: 'private' }, text });
  const latest = () => sent.findLast(item => item.options.replyMarkup);
  const callback = (text, source = latest()) => {
    const button = source.options.replyMarkup.inline_keyboard.flat().find(button => button.text === text);
    assert.ok(button, `Button ${text} exists`);
    return { id: `query-${++queryId}`, from: { id: 202 }, data: button.callback_data,
      message: { message_id: source.message_id, date: 1_783_589_600, chat: { id: 202, type: 'private' }, from: { id: 999, is_bot: true } } };
  };
  const send = (text, id) => handleUpdate({ message: message(text, id) }, context);
  const tap = text => handleUpdate({ callback_query: callback(text) }, context);
  return { ...context, sent, calls, answers, removed, faults, context, message, latest, callback, send, tap,
    setNow: value => { instant = new Date(value); } };
}

test('admin chooses a named diary and every button uses that owner, including export and retry', async () => {
  const f = fixture();
  await f.send('/admin');
  assert.deepEqual(f.latest().options.replyMarkup.inline_keyboard.flat().map(button => button.text), ['Alex (101)', 'Sam (202)', 'Close']);
  assert.deepEqual(f.calls, []);
  await f.tap('Alex (101)');
  assert.match(f.latest().text, /^Diary: Alex \(101\)/);
  for (const [label, action] of [['Today', 'day'], ['Latest day', 'last'], ['Status', 'status'], ['Retry', 'retry'], ['Export', 'export']]) {
    const previous = f.sent.length;
    await f.tap(label);
    assert.ok(f.calls.some(call => call[0] === action && call[1] === 101));
    for (const message of f.sent.slice(previous)) {
      assert.equal(message.chatId, 202);
      assert.match(message.text, /^Diary: Alex \(101\)/);
    }
  }
  assert.deepEqual(f.calls.find(call => call[0] === 'retry'), ['retry', 101, { force: true }]);
  assert.match(f.latest().text, /example.invalid\/export\/101/);
  assert.ok(!f.calls.some(call => call[0] === 'globalRetry'));
  assert.ok(f.removed.length > 0);
  for (const message of f.sent) for (const button of message.options.replyMarkup?.inline_keyboard.flat() || []) {
    assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
});

test('shortcuts require selection, name their target, and Close or cancel clears only admin selection', async () => {
  const f = fixture();
  for (const text of ['/today', '/last', '/day 2026-09-09', '/status', '/export', '/retry']) await f.send(text);
  assert.deepEqual(f.calls, []);
  await f.tap('Alex (101)');
  for (const text of ['/today', '/last', '/day 2026-09-08', '/yesterday', '/status', '/retry', '/export']) {
    await f.send(text);
    assert.match(f.latest().text, /^Diary: Alex \(101\)/);
  }
  await f.send('/help');
  assert.match(f.latest().text, /Voice notes always go into your own diary/);
  await f.tap('Close');
  assert.match(f.latest().text, /No diary is selected/);
  const count = f.calls.length;
  await f.send('/last');
  assert.equal(f.calls.length, count);
  await f.tap('Sam (202)');
  await f.send('/cancel');
  await f.tap('Open admin menu');
  assert.match(f.latest().text, /Choose a diary/);
  assert.equal(f.calls.length, count);
});

test('voice ownership is unaffected by selecting another diary or awaiting a date', async () => {
  const f = fixture();
  await f.send('/admin');
  await f.tap('Alex (101)');
  await f.tap('Choose date');
  for (const id of [202, 101]) await handleUpdate({ message: { ...f.message(undefined, id), voice: { file_id: 'fixture' } } }, f.context);
  assert.deepEqual(f.calls, [['voice', 202], ['process', 202, 'collision'], ['voice', 101], ['process', 101, 'collision']]);
  await f.send('2026-09-08');
  assert.deepEqual(f.calls.at(-1), ['day', 101, '2026-09-08']);
  await f.send('/cancel');
  await handleUpdate({ message: { ...f.message(undefined), voice: { file_id: 'fixture' } } }, f.context);
  assert.deepEqual(f.calls.at(-1), ['process', 202, 'collision']);
});

test('calendar supports leap years, month navigation, date input and London midnight', async () => {
  const f = fixture();
  f.setNow('2028-02-29T23:30:00Z');
  await f.send('/start');
  await f.tap('Alex (101)');
  await f.tap('Choose date');
  const february = f.latest();
  const labels = february.options.replyMarkup.inline_keyboard.flat().map(button => button.text);
  assert.ok(labels.includes('February 2028') && labels.includes('29') && !labels.includes('30'));
  await f.tap('29');
  assert.deepEqual(f.calls.at(-1), ['day', 101, '2028-02-29']);
  await f.send('/day');
  await f.tap('Next month ›');
  assert.ok(f.latest().options.replyMarkup.inline_keyboard.flat().some(button => button.text === 'March 2028'));
  await f.tap('‹ Previous month');
  await f.tap('‹ Previous month');
  await f.tap('‹ Previous month');
  assert.ok(f.latest().options.replyMarkup.inline_keyboard.flat().some(button => button.text === 'December 2027'));
  const before = f.calls.length;
  await f.send('2026-02-30');
  assert.match(f.latest().text, /valid date/);
  assert.equal(f.calls.length, before);
  await f.tap('Back');
  f.setNow('2026-03-29T23:30:00Z');
  await f.tap('Today');
  assert.deepEqual(f.calls.at(-1), ['day', 101, '2026-03-30']);
});

test('stale, replayed, modified and wrong-message buttons cannot run work or switch the selected diary', async () => {
  const f = fixture();
  await f.send('/admin');
  await f.tap('Alex (101)');
  const staleExport = f.callback('Export');
  const staleClose = f.callback('Close');
  await f.tap('Switch person');
  await f.tap('Sam (202)');
  for (const query of [staleExport, staleClose,
    { ...f.callback('Export'), data: f.callback('Export').data.replace(':202:', ':101:') },
    { ...f.callback('Export'), message: { ...f.callback('Export').message, message_id: 99999 } }]) {
    await handleUpdate({ callback_query: query }, f.context);
    assert.match(f.sent.at(-1).text, /expired/);
  }
  assert.deepEqual(f.calls, []);
  await f.send('/last');
  assert.deepEqual(f.calls.at(-1), ['last', 202]);
  const query = f.callback('Export');
  await handleUpdate({ callback_query: query }, f.context);
  await handleUpdate({ callback_query: query }, f.context);
  assert.equal(f.calls.filter(call => call[0] === 'export').length, 1);
  assert.deepEqual(f.calls.find(call => call[0] === 'export'), ['export', 202]);
});

test('ordinary users, groups, inline callbacks and removed accounts cannot use admin controls', async () => {
  const f = fixture();
  await f.send('/admin', 101);
  assert.match(f.sent.at(-1).text, /voice notes/);
  await f.send('/admin', 303);
  assert.match(f.sent.at(-1).text, /only available to approved/);
  await f.send('/admin');
  await f.tap('Alex (101)');
  const query = f.callback('Export');
  const count = f.sent.length;
  for (const invalid of [
    { ...query, from: { id: 101 } }, { ...query, from: { id: 303 } }, { ...query, from: { id: 202, is_bot: true } },
    { ...query, message: { ...query.message, chat: { id: -1, type: 'group' } } },
    { ...query, message: { ...query.message, chat: { id: 101, type: 'private' } } },
    { ...query, message: { ...query.message, date: 0 } },
    { ...query, message: undefined, inline_message_id: 'inline' },
  ]) await handleUpdate({ callback_query: invalid }, f.context);
  assert.equal(f.sent.length, count);
  assert.deepEqual(f.calls, []);
  assert.ok(f.answers.slice(-7).every(answer => /Admin access/.test(answer.text)));
  f.config.diaryUsers = f.config.diaryUsers.filter(user => user.telegramUserId !== 101);
  await handleUpdate({ callback_query: query }, f.context);
  assert.match(f.latest().text, /select the diary again/);
  assert.deepEqual(f.calls, []);
  f.config.adminUserId = 303;
  await handleUpdate({ callback_query: f.callback('Sam (202)') }, f.context);
  assert.deepEqual(f.calls, []);
});

test('new app instances clear selections and reject buttons from before restart', async () => {
  const f = fixture();
  await f.send('/admin');
  await f.tap('Alex (101)');
  const query = f.callback('Export');
  const restarted = { ...f.context, app: { ...f.app } };
  await handleUpdate({ callback_query: query }, restarted);
  assert.match(f.sent.at(-1).text, /expired/);
  await handleUpdate({ message: f.message('/last') }, restarted);
  assert.match(f.latest().text, /Choose a diary/);
  assert.deepEqual(f.calls, []);
});

test('provider and diary failures preserve ownership, expose no raw errors and do not replay mutations', async () => {
  const f = fixture();
  await f.send('/admin');
  await f.tap('Alex (101)');
  f.faults.add('answer');
  f.faults.add('cleanup');
  await f.tap('Status');
  assert.deepEqual(f.calls.at(-1), ['status', 101]);
  f.faults.add(101);
  await f.tap('Export');
  assert.match(f.latest().text, /^Diary: Alex \(101\)/);
  assert.match(f.latest().text, /could not be completed/);
  assert.doesNotMatch(f.latest().text, /Private|secret content/);
  assert.equal(f.calls.filter(call => call[0] === 'export').length, 0);
  f.faults.clear();
  const query = f.callback('Retry');
  const send = f.services.telegram.sendMessage;
  f.services.telegram.sendMessage = async (...args) => {
    if (String(args[1]).startsWith('Retry complete')) throw new Error('Private result delivery failure');
    return send(...args);
  };
  await assert.rejects(handleUpdate({ callback_query: query }, f.context));
  f.services.telegram.sendMessage = send;
  await handleUpdate({ callback_query: query }, f.context);
  assert.equal(f.calls.filter(call => call[0] === 'retry').length, 1);
});

test('callback polling acknowledges before processing voice work and persists its update cursor', async t => {
  const f = fixture();
  const dataDir = await mkdtemp(join(tmpdir(), 'health-admin-poll-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  f.config.dataDir = dataDir;
  await f.send('/admin');
  await f.tap('Alex (101)');
  const query = f.callback('Status');
  const batches = [[{ update_id: 10, message: { ...f.message(undefined), voice: { file_id: 'fixture' } } },
    { update_id: 11, callback_query: query }], []];
  f.services.telegram.getUpdates = async () => batches.shift() ?? [];
  f.app.processEntry = async (entryId, ownerId) => {
    assert.ok(f.answers.some(answer => answer.id === query.id));
    f.calls.push(['process', ownerId, entryId]);
  };
  await runBot({ ...f.context, recoverOnStart: false, maxCycles: 1, logger: () => {} });
  assert.equal((await readJson(join(dataDir, 'telegram.json'))).next_offset, 12);
  assert.deepEqual(f.calls.find(call => call[0] === 'process'), ['process', 202, 'collision']);
  assert.deepEqual(f.calls.at(-1), ['status', 101]);
  assert.equal(f.answers.filter(answer => answer.id === query.id).length, 1);
  assert.ok(f.calls.some(call => call[0] === 'commands' && call[1] === 202));
});

test('admin-only accounts can manage diaries but cannot record voice notes', async () => {
  const f = fixture();
  f.config.diaryUsers = [{ telegramUserId: 101, label: 'Alex' }];
  await f.send('/admin');
  await f.tap('Alex (101)');
  assert.match(f.latest().text, /not enabled for voice entries/);
  await handleUpdate({ message: { ...f.message(undefined), voice: { file_id: 'fixture' } } }, f.context);
  assert.match(f.sent.at(-1).text, /not enabled for voice entries/);
  assert.deepEqual(f.calls, []);
  await f.send('/last');
  assert.deepEqual(f.calls.at(-1), ['last', 101]);
});

test('person picker pages preserve IDs and disambiguate identical labels', async () => {
  const f = fixture();
  f.config.diaryUsers = Array.from({ length: 10 }, (_, index) => ({ telegramUserId: Number.MAX_SAFE_INTEGER - index, label: 'A'.repeat(80) }));
  await f.send('/admin');
  const first = f.latest();
  await f.tap('Next ›');
  const label = `${'A'.repeat(40)} (${Number.MAX_SAFE_INTEGER - 8})`;
  await f.tap(label);
  await f.tap('Latest day');
  assert.deepEqual(f.calls.at(-1), ['last', Number.MAX_SAFE_INTEGER - 8]);
  assert.match(f.latest().text, new RegExp(`Diary: ${'A'.repeat(80)}`));
  assert.equal(first.options.replyMarkup.inline_keyboard.filter(row => row[0].text.startsWith('AAAA')).length, 8);
  for (const message of f.sent) for (const button of message.options.replyMarkup?.inline_keyboard.flat() || []) {
    assert.ok(Buffer.byteLength(button.callback_data) <= 64);
  }
});
