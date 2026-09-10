const networkCodes = new Set(['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'EPIPE']);
const localCodes = new Set(['ENOENT', 'EACCES', 'ENOSPC', 'EIO', 'ELOCKED', 'ECOMPROMISED']);
const serviceCodes = new Set(['DUPLICATE_REMOTE_OBJECT', 'REMOTE_OBJECT_CONFLICT', 'IMMUTABLE_CONTENT_CONFLICT',
  'UPLOAD_CHECKSUM_MISMATCH', 'HEADER_MISMATCH', 'DUPLICATE_REMOTE_KEY', 'INVALID_RESPONSE', 'EMPTY_RESPONSE',
  'INCOMPLETE_RESPONSE', 'MODEL_REFUSAL', 'REQUEST_FAILED', 'REQUEST_ABORTED', 'CONFIGURATION_ERROR',
  'FILE_TOO_LARGE', 'AUDIO_TOO_LARGE', 'INCOMPLETE_AUDIO', 'INVALID_FILE_PATH', 'INVALID_AUDIO', 'DOWNLOAD_SIZE_MISMATCH', 'INVALID_TELEGRAM_CURSOR', 'INVALID_TELEGRAM_RESPONSE']);

export function safeError(error) {
  const status = Number(error?.status ?? error?.response?.status ?? (typeof error?.code === 'number' ? error.code : 0)) || undefined;
  const rawCode = error?.code ?? error?.cause?.code;
  const code = networkCodes.has(rawCode) || localCodes.has(rawCode) || serviceCodes.has(rawCode) ? rawCode : status ? `HTTP_${status}` : 'OPERATION_FAILED';
  const type = status ? 'http' : networkCodes.has(rawCode) ? 'network' : localCodes.has(rawCode) ? 'filesystem' : 'operation';
  const message = status ? `Provider returned HTTP ${status}` : code === 'OPERATION_FAILED' ? 'Operation failed; inspect configuration and provider availability' : code;
  return { type, code, message, ...(status ? { status } : {}) };
}

// Call sites pass only operational identifiers/counters. Never pass provider error bodies.
export function log(event, fields = {}) {
  const safe = {};
  for (const key of ['entry_id', 'date', 'step', 'attempt', 'code', 'count']) {
    if (fields[key] !== undefined) safe[key] = fields[key];
  }
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...safe }));
}
