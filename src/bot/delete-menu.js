import { randomBytes } from 'node:crypto';
import { diaryCallback, isDiaryUser, privateSender } from './access.js';
import { parseCommand } from './commands.js';
import { acknowledgeCallback } from './admin-menu.js';
import { log, safeError } from '../util/logging.js';

const replies = {
  empty: "You haven't recorded any entries today.",
  expired: 'The day has changed. Choose Delete last entry again to check today’s entries.',
  changed: 'You have recorded a newer entry. Choose Delete last entry again to review it.',
  unavailable: 'This diary needs attention before an entry can be deleted. Please contact the administrator.',
  pending: 'Deletion is queued. I will retry the unfinished cleanup and confirm when it is complete.',
  repair_pending: 'This entry is being corrected. Please try deleting it again after the administrator’s repair finishes.',
};

export function createDeleteMenu({ app, config, services }) {
  const pending = new Map();
  const telegram = services.telegram;
  const ownDiary = id => app.multiUser ? app.forUser(id) : app;
  async function clear(id) {
    const old = pending.get(id);
    pending.delete(id);
    if (old) {
      try { await telegram.removeKeyboard(id, old.messageId); }
      catch (error) { log('telegram_delete_menu_cleanup_failed', safeError(error)); }
    }
  }
  async function prepare(id) {
    await clear(id);
    const target = await (await ownDiary(id)).lastEntryToday();
    if (target.status !== 'ready') return telegram.sendMessage(id, replies[target.status]);
    const token = randomBytes(12).toString('base64url');
    const confirm = `undo:${token}:delete`, cancel = `undo:${token}:cancel`;
    const result = await telegram.sendMessage(id,
      `Delete your latest entry from today?\n\n${target.date} at ${target.received_at.slice(11, 19)} (Europe/London)\n${target.preview}\n\n`
      + 'This permanently removes its recording, transcript and summary from the diary and Drive, and removes its Sheets entry. Existing exports and Telegram messages will remain.',
      { replyMarkup: { inline_keyboard: [[{ text: 'Delete', callback_data: confirm }, { text: 'Cancel', callback_data: cancel }]] } });
    pending.set(id, { entryId: target.entry_id, date: target.date, messageId: result.message_id, confirm, cancel });
  }
  return {
    async handleMessage(message) {
      if (!privateSender(message) || !isDiaryUser(message.from.id, config)) return false;
      const command = parseCommand(message.text);
      const id = message.from.id;
      if (command?.name === 'cancel' && pending.has(id)) {
        await clear(id);
        await telegram.sendMessage(id, 'Deletion cancelled. Your entry has been kept.');
        return true;
      }
      if (command?.name !== 'delete_last') return false;
      if (command.argument) {
        await telegram.sendMessage(id, 'Use Delete last entry in the menu, or /delete_last without arguments.');
        return true;
      }
      try { await prepare(id); }
      catch (error) {
        log('diary_delete_preview_failed', safeError(error));
        await telegram.sendMessage(id, 'I could not check your latest entry. Please try again or contact the administrator.');
      }
      return true;
    },
    async handleCallback(query, { answered = false } = {}) {
      if (!answered) await acknowledgeCallback(query, { config, services });
      if (!diaryCallback(query, config)) return;
      const id = query.from.id;
      const target = pending.get(id);
      if (!target || target.messageId !== query.message.message_id
        || ![target.confirm, target.cancel].includes(query.data)) {
        await telegram.sendMessage(id, 'This confirmation has expired. Choose Delete last entry again.');
        return;
      }
      // Consume before any mutation or network call. A double tap cannot undo
      // an additional entry, even if clearing Telegram's old buttons fails.
      await clear(id);
      if (query.data === target.cancel) {
        await telegram.sendMessage(id, 'Deletion cancelled. Your entry has been kept.');
        return;
      }
      try {
        const result = await (await ownDiary(id)).deleteLastEntryToday({ entryId: target.entryId, date: target.date });
        // Successful deletion sends its durable completion notice from the diary.
        if (result.status !== 'complete') await telegram.sendMessage(id, replies[result.status]);
      } catch (error) {
        log('diary_delete_failed', safeError(error));
        await telegram.sendMessage(id, 'I could not confirm completion. If deletion was queued, cleanup will be retried automatically. Please contact the administrator if no confirmation arrives.');
      }
    },
  };
}
