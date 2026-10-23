export function privateSender(message) {
  return Boolean(message && message.chat?.type === 'private' && !message.from?.is_bot
    && Number.isSafeInteger(message.from?.id) && message.from.id > 0 && message.chat.id === message.from.id);
}

export function isDiaryUser(id, config) {
  return config.diaryUsers ? config.diaryUsers.some(user => user.telegramUserId === id) : id === config.diaryUserId;
}

export function messageRole(message, config) {
  if (!privateSender(message)) return null;
  if (message.from.id === config.adminUserId) return 'admin';
  return isDiaryUser(message.from.id, config) ? 'diary_user' : null;
}

export function adminCallback(query, config) {
  return Boolean(query && typeof query.id === 'string' && query.id
    && Number.isSafeInteger(query.message?.message_id) && query.message.message_id > 0
    && query.message.date !== 0 && !query.inline_message_id
    && messageRole({ from: query.from, chat: query.message.chat }, config) === 'admin');
}
