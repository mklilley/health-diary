import { guarded, ServiceError } from './errors.js';

export const TELEGRAM_DOWNLOAD_LIMIT = 20 * 1024 * 1024;

function splitMessage(text, limit = 4096) {
  const chunks = [];
  let remaining = String(text);
  while (remaining.length > limit) {
    let end = limit;
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function createTelegramService(config, { fetchImpl = globalThis.fetch } = {}) {
  const base = `https://api.telegram.org/bot${config.telegramBotToken}`;
  const api = (method, body = {}, signal, timeout = config.httpTimeoutMs) => guarded('telegram', async () => {
    const signals = [AbortSignal.timeout(timeout)];
    if (signal) signals.push(signal);
    const response = await fetchImpl(`${base}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.any(signals), redirect: 'error',
    });
    let result;
    try { result = await response.json(); }
    catch {
      throw new ServiceError('telegram', response.ok ? 'INVALID_RESPONSE' : `HTTP_${response.status}`, response.ok ? undefined : response.status);
    }
    if (!response.ok || !result.ok) {
      const status = Number.isInteger(result.error_code) ? result.error_code : response.ok ? undefined : response.status;
      const error = new ServiceError('telegram', 'API_REJECTED', status);
      if (Number.isSafeInteger(result.parameters?.retry_after) && result.parameters.retry_after > 0) {
        error.retryAfterSeconds = result.parameters.retry_after;
      }
      throw error;
    }
    return result.result;
  });
  return {
    getMe: () => api('getMe'),
    getUpdates: ({ offset = 0, timeout = 30, signal } = {}) => api('getUpdates', {
      offset, timeout, allowed_updates: ['message', 'callback_query'],
    }, signal, Math.max(config.httpTimeoutMs, (timeout + 10) * 1000)),
    answerCallbackQuery: (id, text) => api('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}), cache_time: 0 }, undefined, Math.min(config.httpTimeoutMs, 10000)),
    removeKeyboard: (chatId, messageId) => api('editMessageReplyMarkup', {
      chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] },
    }, undefined, Math.min(config.httpTimeoutMs, 10000)),
    setAdminCommands: chatId => api('setMyCommands', {
      scope: { type: 'chat', chat_id: chatId },
      commands: [{ command: 'admin', description: 'Choose a diary and open admin controls' },
        { command: 'help', description: 'Help and diary controls' }, { command: 'cancel', description: 'Close admin controls and clear selection' }],
    }, undefined, Math.min(config.httpTimeoutMs, 10000)),
    async sendMessage(chatId, text, { replyMarkup, prefix = '' } = {}) {
      if (typeof prefix !== 'string' || prefix.length > 500) throw new ServiceError('telegram', 'INVALID_MESSAGE_PREFIX');
      const chunks = splitMessage(text, 4096 - prefix.length);
      if (!chunks.length) throw new ServiceError('telegram', 'EMPTY_MESSAGE');
      const ids = [];
      for (const [index, chunk] of chunks.entries()) {
        try {
          const message = await api('sendMessage', {
            chat_id: chatId, text: `${prefix}${chunk}`, link_preview_options: { is_disabled: true },
            ...(replyMarkup && index === chunks.length - 1 ? { reply_markup: replyMarkup } : {}),
          });
          if (!Number.isSafeInteger(message?.message_id)) throw new ServiceError('telegram', 'INVALID_RESPONSE');
          ids.push(message.message_id);
        } catch (error) {
          if (ids.length) error.ambiguousDelivery = true;
          throw error;
        }
      }
      return { message_id: ids.at(-1), message_ids: ids };
    },
    downloadVoice: (fileId) => guarded('telegram', async () => {
      const file = await api('getFile', { file_id: fileId });
      if (file.file_size > TELEGRAM_DOWNLOAD_LIMIT) throw new ServiceError('telegram', 'AUDIO_TOO_LARGE');
      if (typeof file.file_path !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(file.file_path)
        || file.file_path.split('/').includes('..') || file.file_path.startsWith('/')) {
        throw new ServiceError('telegram', 'INVALID_FILE_PATH');
      }
      const response = await fetchImpl(`https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`, {
        signal: AbortSignal.timeout(config.httpTimeoutMs), redirect: 'error',
      });
      if (!response.ok) throw new ServiceError('telegram', `HTTP_${response.status}`, response.status);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > TELEGRAM_DOWNLOAD_LIMIT) throw new ServiceError('telegram', 'AUDIO_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
      const audio = Buffer.concat(chunks);
      if (!audio.length || (file.file_size !== undefined && audio.length !== file.file_size)) {
        throw new ServiceError('telegram', 'INCOMPLETE_AUDIO');
      }
      return audio;
    }),
  };
}
