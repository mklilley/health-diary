import { commandReply } from './commands.js';

export function messageRole(message, config) {
  if (!message || message.chat?.type !== 'private' || message.from?.is_bot) return null;
  if (!Number.isSafeInteger(message.from?.id) || !Number.isSafeInteger(message.chat?.id)) return null;
  // All replies containing diary material go to the authenticated private user.
  if (message.chat.id !== message.from.id) return null;
  if (message.from.id === config.sisterUserId) return 'sister';
  if (message.from.id === config.adminUserId) return 'admin';
  return null;
}

export function isDiaryVoice(update, config) {
  return messageRole(update?.message, config) === 'sister' && Boolean(update.message.voice);
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

  const reply = await commandReply(message.text, { role, app, now });
  if (reply) await services.telegram.sendMessage(message.chat.id, reply);
  return null;
}
