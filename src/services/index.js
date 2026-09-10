import { createTelegramService } from './telegram.js';
import { createOpenAIService } from './openai.js';
import { createDriveService } from './google-drive.js';
import { createSheetsService } from './google-sheets.js';
import { loadGoogleAuth } from './google-auth.js';

export async function createServices(config) {
  const auth = await loadGoogleAuth(config);
  return {
    telegram: createTelegramService(config),
    openai: createOpenAIService(config),
    drive: createDriveService(config, { auth }),
    sheets: createSheetsService(config, { auth }),
  };
}
