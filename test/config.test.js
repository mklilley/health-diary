import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const env = {
  TELEGRAM_SISTER_USER_ID: '1001', TELEGRAM_ADMIN_USER_ID: '1002',
  TELEGRAM_BOT_TOKEN: 'test-only', OPENAI_API_KEY: 'test-only',
  GOOGLE_DRIVE_ROOT_FOLDER_ID: 'root-test', GOOGLE_SHEET_ID: 'sheet-test',
};

test('configuration resolves paths and keeps required defaults centralized', () => {
  const config = loadConfig({ env, cwd: '/tmp/test-diary' });
  assert.equal(config.dataDir, '/tmp/test-diary/data');
  assert.equal(config.googleTokenFile, '/tmp/test-diary/tokens/google-token.json');
  assert.equal(config.googleCredentialsFile, '/tmp/test-diary/credentials/google-oauth-client.json');
  assert.equal(config.sisterUserId, 1001);
  assert.equal(config.adminUserId, 1002);
  assert.equal(config.timezone, 'Europe/London');
  assert.equal(config.immediateAttempts, 3);
  assert.equal(config.retryIntervalMs, 900000);
  assert.equal(config.attentionAfterMs, 3600000);
  assert.equal(config.retainLocalAudio, true);
  assert.ok(Object.isFrozen(config));
});

test('offline commands can load config without provider secrets', () => {
  const config = loadConfig({ env: {}, requireSecrets: false });
  assert.equal(config.sisterUserId, null);
  assert.equal(config.openaiApiKey, '');
  assert.equal(config.diaryStartDate, null);
});

test('missing required settings fail without disclosing secrets', () => {
  assert.throws(() => loadConfig({ env: { ...env, OPENAI_API_KEY: '' } }), /Missing required configuration: OPENAI_API_KEY/);
});

test('authorization IDs must be distinct, positive safe integers', () => {
  for (const bad of ['-1', '0', '1.2', '1e3', '9007199254740992', 'secret-input']) {
    assert.throws(() => loadConfig({ env: { ...env, TELEGRAM_SISTER_USER_ID: bad } }), /positive, safe numeric/);
  }
  assert.throws(() => loadConfig({ env: { ...env, TELEGRAM_ADMIN_USER_ID: '1001' } }), /distinct/);
});

test('calendar and retry values are validated', () => {
  for (const date of ['2026-02-29', '2026-13-01', '2026-9-01', 'not-a-date']) {
    assert.throws(() => loadConfig({ env: { ...env, DIARY_START_DATE: date } }), /real ISO date/);
  }
  assert.equal(loadConfig({ env: { ...env, DIARY_START_DATE: '2028-02-29' } }).diaryStartDate, '2028-02-29');
  assert.throws(() => loadConfig({ env: { ...env, TIMEZONE: 'UTC' } }), /Europe\/London/);
  assert.throws(() => loadConfig({ env: { ...env, RETRY_INTERVAL_MS: '-5' } }), /integer/);
  assert.throws(() => loadConfig({ env: { ...env, RETAIN_LOCAL_AUDIO: 'sometimes' } }), /true or false/);
  assert.equal(loadConfig({ env: { ...env, RETAIN_LOCAL_AUDIO: 'false' } }).retainLocalAudio, false);
});

test('model and path overrides are honored', () => {
  const config = loadConfig({ env: { ...env, TRANSCRIPTION_MODEL: 'configured-audio', ENTRY_SUMMARY_MODEL: 'configured-entry', DAILY_SUMMARY_MODEL: 'configured-day', DATA_DIR: '/tmp/custom-data' } });
  assert.equal(config.transcriptionModel, 'configured-audio');
  assert.equal(config.entrySummaryModel, 'configured-entry');
  assert.equal(config.dailySummaryModel, 'configured-day');
  assert.equal(config.dataDir, '/tmp/custom-data');
});
