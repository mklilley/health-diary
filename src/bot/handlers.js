import { commandReply, parseCommand } from './commands.js';
import { reportFailure } from '../runtime.js';
import { isDiaryUser, messageRole, privateSender } from './access.js';
import { createAdminMenu, acknowledgeCallback } from './admin-menu.js';

export { messageRole } from './access.js';

// Menu state is intentionally transient: restarting the app clears selections
// and makes all buttons from that earlier process expire.
const menus = new WeakMap();
function adminMenu(context) {
  if (!menus.has(context.app)) menus.set(context.app, createAdminMenu(context));
  return menus.get(context.app);
}

export function isInteraction(update, config) {
  return Boolean(update?.callback_query || messageRole(update?.message, config)
    || (config.diaryUsers && privateSender(update?.message)));
}

export function isDiaryVoice(update, config) {
  return Boolean(messageRole(update?.message, config) && isDiaryUser(update.message.from.id, config) && update.message.voice);
}

/** Only authenticated private messages can record or access a diary. */
export async function handleUpdate(update, { app, services, config, process = true, now, callbackAnswered = false }) {
  const context = { app, services, config, now };
  if (update?.callback_query) {
    if (app.multiUser) await adminMenu(context).handleCallback(update.callback_query, { answered: callbackAnswered });
    else if (!callbackAnswered) await acknowledgeCallback(update.callback_query, context);
    return null;
  }
  const message = update?.message;
  const role = messageRole(message, config);
  if (!role) {
    if (config.diaryUsers && privateSender(message)) await services.telegram.sendMessage(message.chat.id, 'Sorry, this bot is only available to approved diary users.');
    return null;
  }

  if (message.voice) {
    if (!isDiaryUser(message.from.id, config)) {
      await services.telegram.sendMessage(message.chat.id, config.diaryUsers
        ? 'Your account is not enabled for voice entries. Open /admin for diary controls.'
        : 'Admin voice notes are not added to the diary. Type /help for admin commands.');
      return null;
    }
    const entry = await app.receiveVoice(message);
    if (process) await app.processEntry(entry.entry_id, message.from.id);
    return entry;
  }

  if (app.multiUser && role === 'admin') {
    await adminMenu(context).handleMessage(message);
    return null;
  }

  const command = parseCommand(message.text);
  const exporting = !app.multiUser && role === 'admin' && command?.name === 'export' && !command.argument;
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
