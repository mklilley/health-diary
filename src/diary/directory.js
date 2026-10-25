import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite, atomicWriteJson, readJson } from '../util/atomic-write.js';
import { withLock } from '../util/lock.js';
import { safeError } from '../util/logging.js';
import { createStore } from './metadata.js';

export function directoryText(users) {
  return `Health Diary users\n\n${users.map(user => `${user.telegramUserId}\t${user.label}`).join('\n')}\n\nFolder names are Telegram user IDs. Labels are maintained from users.json.\n`;
}

export function ownerText(user) {
  return `Health Diary\n\nOwner: ${user.label}\nTelegram user ID: ${user.telegramUserId}\n\nThis label is maintained from users.json.\n`;
}

/** Only these generated labels change here; health exports remain on demand. */
export async function syncDirectory({ config, services, configs, now }) {
  if (!services.drive || !services.forDiary) return { skipped: 'offline', errors: [] };
  return withLock(config.dataDir, async () => {
    const path = join(config.dataDir, 'directory.json');
    let state = await readJson(path, null);
    if (state && (state.schema_version !== 1 || state.root_folder_id !== config.googleDriveRootFolderId
      || !state.files || typeof state.files !== 'object' || Array.isArray(state.files))) throw new Error('Invalid directory state');
    state ||= { schema_version: 1, root_folder_id: config.googleDriveRootFolderId, files: {} };
    const errors = [];
    let updated = 0;
    async function upload(key, text, filePath, parent) {
      const hash = createHash('sha256').update(text).digest('hex');
      const previous = state.files[key];
      if (previous?.hash === hash && previous?.id) return;
      await atomicWrite(filePath, text);
      const result = await services.drive.putFile({ parentId: await parent(), name: key === 'index' ? 'diary-users.txt' : 'owner.txt',
        path: filePath, mimeType: 'text/plain', fileId: previous?.id, mutable: true });
      state.files[key] = { id: result.id, hash };
      await atomicWriteJson(path, state);
      updated++;
    }
    try {
      await upload('index', directoryText(config.diaryUsers), join(config.dataDir, 'diary-users.txt'), async () => config.googleDriveRootFolderId);
    } catch (error) { errors.push({ target: 'index', ...safeError(error) }); }
    for (const user of config.diaryUsers) {
      const scoped = configs.get(user.telegramUserId);
      try {
        await withLock(scoped.dataDir, async () => {
          await createStore(scoped, now).init();
          const archive = services.forDiary(scoped).archive;
          await upload(String(user.telegramUserId), ownerText(user), join(scoped.dataDir, 'owner.txt'), () => archive.rootFolder());
        });
      } catch (error) { errors.push({ target: 'owner', telegram_user_id: user.telegramUserId, ...safeError(error) }); }
    }
    state.errors = errors;
    await atomicWriteJson(path, state);
    return { updated, errors };
  }, { name: 'directory' });
}
