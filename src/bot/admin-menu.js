import { randomBytes } from 'node:crypto';
import { commandReply, parseCommand } from './commands.js';
import { adminCallback, diaryCallback, isDiaryUser, messageRole } from './access.js';
import { calendar } from './calendar.js';
import { localDate, validateDate } from '../util/dates.js';
import { log, safeError } from '../util/logging.js';

const pageSize = 8;
const diaryCommands = new Set(['today', 'yesterday', 'last', 'day', 'export', 'status', 'retry']);
const repairReplies = {
  disabled: 'No vocabulary corrections are enabled for this diary. Enable a vocabulary profile before checking existing transcripts.',
  empty: 'No transcript corrections are needed. Entries already processed with the selected vocabulary profiles are skipped.',
  unavailable: 'Some diary source files need attention. Check Status before repairing transcripts.',
  pending: 'Transcript repair is in progress. Scheduled retries will continue it; use Retry pending to try again now, or Status for details.',
  changed: 'The diary changed since the preview. Choose Fix transcripts again to review the current matches.',
};

function changePreview(before, after) {
  let index = 0;
  while (index < Math.min(before.length, after.length) && before[index] === after[index]) index++;
  const start = Math.max(0, index - 35);
  const excerpt = text => `${start ? '…' : ''}${text.slice(start, start + 120).replace(/\s+/g, ' ')}${text.length > start + 120 ? '…' : ''}`;
  return `Before: ${excerpt(before)}\nAfter: ${excerpt(after)}`;
}

// Acknowledge on receipt, before voice processing or exports can delay the
// interaction. Acknowledgement grants no access; dispatch checks again.
export async function acknowledgeCallback(query, { config, services }) {
  if (typeof query?.id !== 'string' || !query.id) return;
  try {
    const undo = typeof query.data === 'string' && query.data.startsWith('undo:');
    const allowed = undo ? diaryCallback(query, config) : adminCallback(query, config);
    await services.telegram.answerCallbackQuery(query.id, allowed ? undefined
      : undo ? 'Diary access is required.' : 'Admin access is required.');
  } catch (error) { log('telegram_callback_answer_failed', safeError(error)); }
}

export function createAdminMenu({ app, config, services, now = () => new Date() }) {
  const telegram = services.telegram;
  let selectedId = null;
  let awaitingDate = false;
  let menu = null;
  const userFor = id => config.diaryUsers.find(user => user.telegramUserId === id);
  const header = user => `Diary: ${user.label} (${user.telegramUserId})\n\n`;
  const voiceHint = () => isDiaryUser(config.adminUserId, config)
    ? 'Voice notes always go into your own diary, including while this menu is open.'
    : 'Your account is not enabled for voice entries.';

  async function invalidate() {
    const old = menu;
    menu = null; // Invalidate before any network call, even if removing buttons fails.
    if (old) {
      try { await telegram.removeKeyboard(config.adminUserId, old.messageId); }
      catch (error) { log('telegram_menu_cleanup_failed', safeError(error)); }
    }
  }

  async function publish(text, user, buildRows) {
    await invalidate();
    const token = randomBytes(9).toString('base64url');
    const allowed = new Map();
    const button = (text, action, argument = '', ownerId = user?.telegramUserId ?? 0) => {
      const data = `hd:${token}:${ownerId}:${action}${argument ? `:${argument}` : ''}`;
      if (Buffer.byteLength(data) > 64) throw new Error('Menu callback exceeds Telegram limit');
      allowed.set(data, { action, argument, ownerId });
      return { text, callback_data: data };
    };
    const replyMarkup = { inline_keyboard: buildRows(button) };
    const result = await telegram.sendMessage(config.adminUserId, text, { replyMarkup, prefix: user ? header(user) : '' });
    menu = { messageId: result.message_id, allowed };
  }

  async function picker(page = 0, notice = '') {
    selectedId = null;
    awaitingDate = false;
    const users = config.diaryUsers;
    const lastPage = Math.max(0, Math.ceil(users.length / pageSize) - 1);
    page = Math.min(Math.max(page, 0), lastPage);
    await publish(`${notice ? `${notice}\n\n` : ''}Choose a diary to manage.\n\n${voiceHint()}`, null, button => {
      const rows = users.slice(page * pageSize, (page + 1) * pageSize).map(user => [button(
        `${[...user.label].slice(0, 40).join('')} (${user.telegramUserId})`, 'select', '', user.telegramUserId)]);
      const pages = [];
      if (page > 0) pages.push(button('‹ Previous', 'page', String(page - 1)));
      if (page < lastPage) pages.push(button('Next ›', 'page', String(page + 1)));
      if (pages.length) rows.push(pages);
      rows.push([button('Close', 'close')]);
      return rows;
    });
  }

  async function actions(user, text = `Choose an action below.\n\n${voiceHint()}`) {
    awaitingDate = false;
    await publish(text, user, button => [
      [button('Today', 'today'), button('Latest day', 'last')],
      [button('Choose date', 'date'), button('Export', 'export')],
      [button('Status', 'status'), button('Retry pending', 'retry')],
      [button('Fix transcripts', 'repair')],
      [button('Switch person', 'switch'), button('Close', 'close')],
    ]);
    selectedId = user.telegramUserId;
  }

  async function dates(user, month = localDate(now()).slice(0, 7), notice = '') {
    await publish(`${notice ? `${notice}\n\n` : ''}Choose a date below, or send a date as YYYY-MM-DD.`, user, button => {
      const { title, rows } = calendar(month, button);
      return [[button(title, 'noop')], ...rows, [button('Back', 'back'), button('Switch person', 'switch'), button('Close', 'close')]];
    });
    awaitingDate = true;
  }

  async function close() {
    selectedId = null;
    awaitingDate = false;
    await publish(`Admin menu closed. No diary is selected.\n\n${voiceHint()}`, null, button => [[button('Open admin menu', 'open')]]);
  }

  async function repair(user, fingerprint) {
    awaitingDate = false;
    await invalidate();
    let result;
    try {
      const scoped = await app.forUser(user.telegramUserId);
      if (fingerprint) {
        await telegram.sendMessage(config.adminUserId, 'Correcting transcripts and regenerating affected summaries. Google updates may take a few minutes.', { prefix: header(user) });
        result = await scoped.repairTranscripts(fingerprint);
      } else result = await scoped.previewTranscriptRepair();
    } catch (error) {
      log('admin_transcript_repair_failed', { telegram_user_id: user.telegramUserId, ...safeError(error) });
      return actions(user, 'The transcript repair could not be completed. Check Status, then use Retry pending to resume any saved work.');
    }
    if (result.status === 'ready') {
      const examples = result.entries.slice(0, 8).map(entry => `${entry.received_at}\n${changePreview(entry.before, entry.after)}`);
      const text = [`Found ${result.entries.length} entries to correct and ${result.day_count} saved daily summaries to regenerate.`, '',
        'First change in each matching entry:', ...examples,
        ...(result.entries.length > 8 ? [`Showing 8 of ${result.entries.length} matching entries.`] : []), '',
        'Apply the selected vocabulary corrections to these saved transcripts and regenerate their entry summaries and affected daily summaries? Drive files and Sheets rows will be updated.',
        result.refresh_exports ? 'Existing aggregate exports will also be refreshed.' : 'No aggregate export will be created.',
        'Local backups will be kept. Original recordings stay unchanged. Only this diary is affected.',
      ].join('\n\n');
      await publish(text, user, button => [[button('Apply corrections', 'repair_confirm'), button('Back', 'back')]]);
      menu.repairFingerprint = result.fingerprint;
      return;
    }
    return actions(user, result.status === 'complete'
      ? `Repair complete.\n\nEntries corrected: ${result.entry_count}\nDaily summaries regenerated: ${result.day_count}\nDrive and Sheets updated.${result.refreshed_exports ? '\nExisting exports refreshed.' : ''}\n\nOriginal text is backed up locally.`
      : repairReplies[result.status] || repairReplies.pending);
  }

  async function run(text, user) {
    // Consume the current buttons before starting. Replayed export/retry clicks
    // cannot cause a second operation, and the owner is captured explicitly.
    awaitingDate = false;
    await invalidate();
    const command = parseCommand(text);
    let reply;
    try {
      const scoped = await app.forUser(user.telegramUserId);
      if (['export', 'retry'].includes(command?.name) && !command.argument) {
        await telegram.sendMessage(config.adminUserId, command.name === 'export'
          ? 'Preparing the diary export. I will send the Drive links when it is ready.'
          : 'Retrying pending work for this diary.', { prefix: header(user) });
      }
      reply = await commandReply(text, { role: 'admin', app: scoped, now });
    } catch (error) {
      log('admin_diary_action_failed', { telegram_user_id: user.telegramUserId, ...safeError(error) });
      reply = 'This action could not be completed. Check Status or the bot logs before trying again.';
    }
    await actions(user, reply);
  }

  return {
    async handleMessage(message) {
      if (messageRole(message, config) !== 'admin') return;
      const command = parseCommand(message.text);
      if (command?.name === 'cancel') return close();
      if (command?.name === 'admin' || command?.name === 'start') return picker();
      if (command?.name === 'help') return telegram.sendMessage(config.adminUserId, 'Open /admin to choose a diary and use the controls.');
      const user = userFor(selectedId);
      if (!user) return picker();
      if (awaitingDate && !command) {
        const date = message.text?.trim();
        return validateDate(date) ? run(`/day ${date}`, user) : dates(user, undefined, 'Please choose a day or send a valid date, for example 2026-09-15.');
      }
      if (command?.name === 'day' && !command.argument) return dates(user);
      if (command?.name === 'repair' && !command.argument) return repair(user);
      if (diaryCommands.has(command?.name)) return run(message.text, user);
      return actions(user);
    },
    async handleCallback(query, { answered = false } = {}) {
      if (!answered) await acknowledgeCallback(query, { config, services });
      if (!adminCallback(query, config)) return;
      const payload = menu?.messageId === query.message.message_id && menu.allowed.get(query.data);
      if (!payload) {
        await telegram.sendMessage(config.adminUserId, 'This menu has expired. Use the latest buttons or open /admin.');
        return;
      }
      const { action, argument, ownerId } = payload;
      const user = userFor(ownerId);
      if (ownerId && (!user || (action !== 'select' && selectedId !== ownerId))) return picker(0, 'Please select the diary again.');
      if (action === 'noop') return;
      switch (action) {
        case 'open': case 'switch': return picker();
        case 'page': return picker(Number(argument));
        case 'close': return close();
        case 'select': return actions(user);
        case 'back': return actions(user);
        case 'date': return dates(user);
        case 'month': return dates(user, argument);
        case 'day': return run(`/day ${argument}`, user);
        case 'repair': return repair(user);
        case 'repair_confirm': return repair(user, menu.repairFingerprint);
        default: return run(`/${action}`, user);
      }
    },
  };
}
