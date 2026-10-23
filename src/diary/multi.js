import { join } from 'node:path';
import { ConfigurationError, validateDiaryUsers } from '../config.js';
import { atomicWriteJson, exists, readJson } from '../util/atomic-write.js';
import { withLock } from '../util/lock.js';
import { log, safeError } from '../util/logging.js';
import { createDiary } from './index.js';
import { createPollingState } from './polling.js';

export async function createMultiDiary({ config, services = {}, now = () => new Date(), ...options }) {
  const users = validateDiaryUsers(config.diaryUsers);
  await withLock(config.dataDir, async () => {
    for (const name of ['state.json', 'entries', 'days', 'aggregates']) {
      if (await exists(join(config.dataDir, name))) {
        throw new ConfigurationError('Existing single-user data requires migration before multi-user mode can start.');
      }
    }
    const path = join(config.dataDir, 'layout.json');
    const layout = await readJson(path, null);
    if (layout && (layout.schema_version !== 2 || layout.kind !== 'multi-user')) {
      throw new ConfigurationError('Unsupported diary storage layout.');
    }
    if (!layout) await atomicWriteJson(path, { schema_version: 2, kind: 'multi-user' });
  });
  const polling = await createPollingState({ config, services, now });
  const configs = new Map(users.map(user => [user.telegramUserId, Object.freeze({ ...config,
    diaryUserId: user.telegramUserId, diaryLabel: user.label, requireDiaryOwner: true,
    dataDir: join(config.dataDir, 'users', String(user.telegramUserId)),
    diaryStartDate: null, googleSheetId: null,
    pollingStateFile: join(config.dataDir, 'polling.json'),
  })]));
  async function forUser(id) {
    const scoped = configs.get(id);
    if (!scoped) throw new ConfigurationError('Select a configured diary by its numeric Telegram user ID.');
    // Revalidate ownership on each operation, including in long-running bots.
    return createDiary({ ...options, now, config: scoped, services: services.forDiary ? services.forDiary(scoped) : {} });
  }
  async function each(action) {
    const diaries = [], errors = [];
    for (const user of users) {
      try { diaries.push({ telegram_user_id: user.telegramUserId, label: user.label, result: await action(await forUser(user.telegramUserId)) }); }
      catch (error) {
        const failure = { telegram_user_id: user.telegramUserId, ...safeError(error) };
        errors.push(failure);
        log('diary_operation_failed', failure);
      }
    }
    return { diaries, errors };
  }
  // Establish a start date for every enabled diary, even before its first voice
  // note. A corrupt diary must not prevent other diaries' scheduled work.
  await each(async () => undefined);
  return {
    multiUser: true, users, forUser,
    ...polling,
    receiveVoice: async message => (await forUser(message.from?.id)).receiveVoice(message),
    processEntry: async (entryId, ownerId) => (await forUser(ownerId)).processEntry(entryId),
    retry: async args => {
      const result = await each(app => app.retry(args));
      const totals = Object.fromEntries(['checked', 'resolved', 'retrying', 'attention']
        .map(key => [key, result.diaries.reduce((sum, diary) => sum + diary.result[key], 0)]));
      return { ...totals, ...result };
    },
    daily: async () => {
      const result = await each(async app => ({ days_checked: (await app.daily()).length }));
      return { days_checked: result.diaries.reduce((sum, diary) => sum + diary.result.days_checked, 0), ...result };
    },
    reminder: () => each(app => app.reminder()),
    rebuildAggregates: () => each(app => app.rebuildAggregates()),
    status: async () => {
      const { diaries, errors } = await each(app => app.status());
      return [...diaries.map(diary => diary.result), ...errors.map(error => `Diary ${error.telegram_user_id}: unavailable (${error.code})`)].join('\n\n');
    },
    showDay: async (date, ownerId) => (await forUser(ownerId)).showDay(date),
    lastDay: async ownerId => (await forUser(ownerId)).lastDay(),
    exportAggregates: async ownerId => (await forUser(ownerId)).exportAggregates(),
  };
}
