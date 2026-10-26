import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

export class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
    this.code = 'CONFIGURATION_ERROR';
  }
}

export function validateDiaryUsers(value) {
  if (!Array.isArray(value) || !value.length) throw new ConfigurationError('DIARY_USERS_FILE must contain a nonempty JSON array.');
  const ids = new Set();
  return Object.freeze(value.map(user => {
    if (!user || typeof user !== 'object' || Array.isArray(user)
      || Object.keys(user).some(key => !['telegramUserId', 'label'].includes(key))
      || !Number.isSafeInteger(user.telegramUserId) || user.telegramUserId <= 0
      || typeof user.label !== 'string' || !user.label.trim() || user.label.trim().length > 80
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(user.label)) {
      throw new ConfigurationError('Each diary user requires a positive numeric telegramUserId and a single-line label of 1–80 characters, with no other fields.');
    }
    if (ids.has(user.telegramUserId)) throw new ConfigurationError('DIARY_USERS_FILE contains duplicate Telegram user IDs.');
    ids.add(user.telegramUserId);
    return Object.freeze({ telegramUserId: user.telegramUserId, label: user.label.trim() });
  }));
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
  const diaryUsersFile = value('DIARY_USERS_FILE') ? resolve(cwd, value('DIARY_USERS_FILE')) : null;
  let diaryUsers;
  if (diaryUsersFile) {
    let contents;
    try { contents = JSON.parse(readFileSync(diaryUsersFile, 'utf8')); }
    catch { throw new ConfigurationError('Cannot read DIARY_USERS_FILE as JSON. Check its path, permissions and syntax.'); }
    diaryUsers = validateDiaryUsers(contents);
    if (['TELEGRAM_DIARY_USER_ID', 'GOOGLE_SHEET_ID', 'DIARY_START_DATE'].some(key => value(key))) {
      throw new ConfigurationError('Complete the multi-user migration before removing the legacy diary, Sheet and start-date settings.');
    }
  }
  const diaryUserId = diaryUsersFile ? null : userId('TELEGRAM_DIARY_USER_ID');
  const adminUserId = userId('TELEGRAM_ADMIN_USER_ID');
  if (diaryUserId !== null && diaryUserId === adminUserId) {
    throw new ConfigurationError('The diary user and admin must have distinct Telegram user IDs.');
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
    timezone, diaryUserId, adminUserId,
    diaryUsersFile, diaryUsers,
    telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
    openaiApiKey: required('OPENAI_API_KEY'),
    transcriptionModel: value('TRANSCRIPTION_MODEL', 'gpt-transcribe'),
    entrySummaryModel: value('ENTRY_SUMMARY_MODEL', 'gpt-4.1-mini'),
    dailySummaryModel: value('DAILY_SUMMARY_MODEL', 'gpt-4.1-mini'),
    googleDriveRootFolderId: required('GOOGLE_DRIVE_ROOT_FOLDER_ID'),
    googleSheetId: diaryUsersFile ? null : required('GOOGLE_SHEET_ID'),
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
