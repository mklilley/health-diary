import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
    this.code = 'CONFIGURATION_ERROR';
  }
}

// Explicit env/cwd inputs keep configuration tests independent of local secrets.
export function loadConfig({ requireSecrets = true, env = process.env, cwd = process.cwd() } = {}) {
  if (env === process.env) {
    try { loadEnvFile(resolve(cwd, '.env')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new ConfigurationError('Cannot read .env. Check its permissions and syntax.');
    }
  }
  const value = (name, fallback = '') => env[name]?.trim() || fallback;
  const required = (name) => {
    const result = value(name);
    if (requireSecrets && !result) throw new ConfigurationError(`Missing required configuration: ${name}`);
    return result;
  };
  const userId = (name) => {
    const input = required(name);
    if (!input && !requireSecrets) return null;
    const result = Number(input);
    if (!/^[1-9]\d*$/.test(input) || !Number.isSafeInteger(result)) {
      throw new ConfigurationError(`${name} must be a positive, safe numeric Telegram user ID.`);
    }
    return result;
  };
  const integer = (name, fallback, minimum = 1) => {
    const input = value(name, String(fallback));
    const result = Number(input);
    if (!/^\d+$/.test(input) || !Number.isSafeInteger(result) || result < minimum) {
      throw new ConfigurationError(`${name} must be an integer of at least ${minimum}.`);
    }
    return result;
  };
  const timezone = value('TIMEZONE', 'Europe/London');
  if (timezone !== 'Europe/London') throw new ConfigurationError('TIMEZONE must be Europe/London for this diary.');
  const sisterUserId = userId('TELEGRAM_SISTER_USER_ID');
  const adminUserId = userId('TELEGRAM_ADMIN_USER_ID');
  if (sisterUserId !== null && sisterUserId === adminUserId) {
    throw new ConfigurationError('The sister and admin must have distinct Telegram user IDs.');
  }
  const diaryStartDate = value('DIARY_START_DATE') || null;
  if (diaryStartDate && (!/^\d{4}-\d{2}-\d{2}$/.test(diaryStartDate)
    || !Number.isFinite(Date.parse(`${diaryStartDate}T00:00:00Z`))
    || new Date(`${diaryStartDate}T00:00:00Z`).toISOString().slice(0, 10) !== diaryStartDate)) {
    throw new ConfigurationError('DIARY_START_DATE must be a real ISO date (YYYY-MM-DD).');
  }
  // Keeping originals is the default; optional cleanup requires proven archival in core.
  const retainLocalAudio = value('RETAIN_LOCAL_AUDIO', 'true');
  if (!['true', 'false'].includes(retainLocalAudio)) {
    throw new ConfigurationError('RETAIN_LOCAL_AUDIO must be true or false.');
  }
  return Object.freeze({
    dataDir: resolve(cwd, value('DATA_DIR', 'data')),
    timezone, sisterUserId, adminUserId,
    telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
    openaiApiKey: required('OPENAI_API_KEY'),
    transcriptionModel: value('TRANSCRIPTION_MODEL', 'gpt-4o-transcribe'),
    entrySummaryModel: value('ENTRY_SUMMARY_MODEL', 'gpt-4.1-mini'),
    dailySummaryModel: value('DAILY_SUMMARY_MODEL', 'gpt-4.1-mini'),
    googleDriveRootFolderId: required('GOOGLE_DRIVE_ROOT_FOLDER_ID'),
    googleSheetId: required('GOOGLE_SHEET_ID'),
    googleCredentialsFile: resolve(cwd, value('GOOGLE_CREDENTIALS_FILE', 'credentials/google-oauth-client.json')),
    googleTokenFile: resolve(cwd, value('GOOGLE_TOKEN_FILE', 'tokens/google-token.json')),
    diaryStartDate,
    immediateAttempts: integer('IMMEDIATE_ATTEMPTS', 3),
    retryBaseMs: integer('RETRY_BASE_MS', 1000, 0),
    retryIntervalMs: integer('RETRY_INTERVAL_MS', 900000),
    attentionAfterMs: integer('ATTENTION_AFTER_MS', 3600000),
    httpTimeoutMs: integer('HTTP_TIMEOUT_MS', 120000),
    retainLocalAudio: retainLocalAudio === 'true',
  });
}
