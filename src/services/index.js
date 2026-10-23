import { createTelegramService } from './telegram.js';
import { createOpenAIService } from './openai.js';
import { createDriveService } from './google-drive.js';
import { createSheetsService } from './google-sheets.js';
import { loadGoogleAuth } from './google-auth.js';
import { createDiaryArchive } from './diary-archive.js';

export async function createServices(config) {
  const auth = await loadGoogleAuth(config);
  const shared = {
    telegram: createTelegramService(config),
    openai: createOpenAIService(config),
    drive: createDriveService(config, { auth }),
  };
  if (!config.diaryUsers) return { ...shared, sheets: createSheetsService(config, { auth }) };
  return { ...shared, forDiary: scoped => ({ ...shared, ...createDiaryArchive(scoped, { drive: shared.drive, auth }) }) };
}
