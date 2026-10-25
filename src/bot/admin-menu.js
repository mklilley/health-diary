import { randomBytes } from 'node:crypto';
import { commandReply, parseCommand } from './commands.js';
import { adminCallback, isDiaryUser, messageRole } from './access.js';
import { calendar } from './calendar.js';
import { localDate, validateDate } from '../util/dates.js';
import { log, safeError } from '../util/logging.js';

const pageSize = 8;
const diaryCommands = new Set(['today', 'yesterday', 'last', 'day', 'export', 'status', 'retry']);

// Acknowledge on receipt, before voice processing or exports can delay the
// interaction. Acknowledgement grants no access; dispatch checks again.
export async function acknowledgeCallback(query, { config, services }) {
  if (typeof query?.id !== 'string' || !query.id) return;
  try {
    await services.telegram.answerCallbackQuery(query.id, adminCallback(query, config) ? undefined : 'Admin access is required.');
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
        default: return run(`/${action}`, user);
      }
    },
  };
}
