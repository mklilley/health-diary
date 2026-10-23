import { join } from 'node:path';
import { atomicWriteJson, readJson } from '../util/atomic-write.js';
import { ServiceError } from './errors.js';
import { createSheetsService } from './google-sheets.js';

// Called only inside the owner's writer lock. Receipts and offline reads never
// need Drive; a failed or interrupted provisioning attempt can be retried.
export function createDiaryArchive(config, { drive, auth, sheetsFactory = createSheetsService }) {
  const path = join(config.dataDir, 'archive.json');
  async function readBinding() {
    let binding;
    try { binding = await readJson(path, null); }
    catch { throw new ServiceError('drive', 'DIARY_ARCHIVE_INVALID'); }
    if (binding && (binding.schema_version !== 1 || binding.telegram_user_id !== config.diaryUserId
      || binding.root_folder_id !== config.googleDriveRootFolderId
      || typeof binding.drive_folder_id !== 'string' || !binding.drive_folder_id
      || (binding.spreadsheet_id !== undefined && (typeof binding.spreadsheet_id !== 'string' || !binding.spreadsheet_id)))) {
      throw new ServiceError('drive', 'DIARY_ARCHIVE_INVALID');
    }
    return binding;
  }
  async function folderBinding() {
    let binding = await readBinding();
    const folder = await drive.ensureFolder(config.googleDriveRootFolderId, String(config.diaryUserId), binding?.drive_folder_id);
    if (!binding) {
      binding = { schema_version: 1, telegram_user_id: config.diaryUserId,
        root_folder_id: config.googleDriveRootFolderId, drive_folder_id: folder.id };
      await atomicWriteJson(path, binding);
    }
    return binding;
  }
  async function sheets() {
    const binding = await folderBinding();
    const sheet = await drive.ensureSpreadsheet(binding.drive_folder_id, 'Diary Index', binding.spreadsheet_id);
    if (!binding.spreadsheet_id) {
      binding.spreadsheet_id = sheet.id;
      await atomicWriteJson(path, binding);
    }
    return sheetsFactory({ ...config, googleSheetId: sheet.id }, { auth });
  }
  return {
    archive: { rootFolder: async () => (await folderBinding()).drive_folder_id },
    sheets: Object.fromEntries(['upsertEntry', 'upsertDay', 'ensureTabs']
      .map(method => [method, async (...args) => (await sheets())[method](...args)])),
  };
}
