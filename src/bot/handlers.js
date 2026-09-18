import { commandReply, parseCommand } from './commands.js';
import { reportFailure } from '../runtime.js';

export function messageRole(message, config) {
  if (!message || message.chat?.type !== 'private' || message.from?.is_bot) return null;
  if (!Number.isSafeInteger(message.from?.id) || !Number.isSafeInteger(message.chat?.id)) return null;
  // All replies containing diary material go to the authenticated private user.
  if (message.chat.id !== message.from.id) return null;
  if (message.from.id === config.diaryUserId) return 'diary_user';
  if (message.from.id === config.adminUserId) return 'admin';
  return null;
}

export function isDiaryVoice(update, config) {
  return messageRole(update?.message, config) === 'diary_user' && Boolean(update.message.voice);
}

/** Edited messages, channel posts, groups and unknown senders are ignored. */
export async function handleUpdate(update, { app, services, config, process = true, now }) {
  const message = update?.message;
  const role = messageRole(message, config);
  if (!role) return null;

  if (message.voice) {
    if (role === 'admin') {
      await services.telegram.sendMessage(message.chat.id, 'Admin voice notes are not added to the diary. Type /help for admin commands.');
      return null;
    }
    const entry = await app.receiveVoice(message);
    if (process) await app.processEntry(entry.entry_id);
    return entry;
  }

  const command = parseCommand(message.text);
  const exporting = role === 'admin' && command?.name === 'export' && !command.argument;
  if (exporting) await services.telegram.sendMessage(message.chat.id, 'Preparing the diary export. I will send Drive links when it is ready.');
  let reply;
  try { reply = await commandReply(message.text, { role, app, now }); }
  catch (error) {
    if (!exporting) throw error;
    reportFailure('export_failed', error);
    reply = 'The export could not be completed. Use /status for details and check the bot logs. Send /export again after resolving the problem.';
  }
  if (reply) await services.telegram.sendMessage(message.chat.id, reply);
  return null;
}
