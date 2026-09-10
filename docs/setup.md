# Account setup

[Back to the README](../README.md)

Complete the installation commands in the README first. Edit `.env` in a text editor; the bot loads it when it starts. Existing environment variables take precedence over the file.

## 1. Telegram

1. Open [BotFather](https://t.me/BotFather) in Telegram, send `/newbot`, and follow the prompts. Put the resulting token in `TELEGRAM_BOT_TOKEN`.
2. Have both the diary user and administrator open the new bot and press **Start**. These must be two distinct accounts.
3. Before starting the application, run the following command from the repository directory to find their numeric IDs. It prints private-chat names and IDs, without printing message content or advancing the update offset.

```bash
node --input-type=module <<'NODE'
import { loadEnvFile } from 'node:process';
import { createTelegramService } from './src/services/telegram.js';
loadEnvFile('.env');
const telegram = createTelegramService({
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  httpTimeoutMs: 15000,
});
try {
  const updates = await telegram.getUpdates({ timeout: 0 });
  const users = new Map();
  for (const { message } of updates) {
    if (message?.chat?.type === 'private') users.set(message.from.id, message.from.first_name);
  }
  for (const [id, name] of users) console.log(id, name);
} catch {
  console.error('Could not read Telegram updates. Check the token and stop any other bot instance.');
  process.exitCode = 1;
}
NODE
```

Fill in these values in `.env`:

| Setting | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Token from BotFather. |
| `TELEGRAM_SISTER_USER_ID` | Numeric ID of the diary user. This is the existing configuration name for that role. |
| `TELEGRAM_ADMIN_USER_ID` | Numeric ID of the administrator. |

If no users appear, send `/start` to the bot again and rerun the command. Do not run it alongside an active bot. You can also disable joining groups through BotFather's `/setjoingroups`; the application already ignores group messages.

An existing webhook must be removed before long polling will work. When using Telegram's `deleteWebhook` method, keep `drop_pending_updates=false` to preserve queued messages. See the [Telegram bot documentation](https://core.telegram.org/bots/api).

## 2. OpenAI

Create an API key in your [OpenAI API account](https://platform.openai.com/api-keys), enable API billing, and put the key in `OPENAI_API_KEY`. A ChatGPT subscription does not supply API access for this bot.

The example configuration selects `gpt-4o-transcribe` for transcription and `gpt-4.1-mini` for summaries. Confirm your API project can use those models, or change the model settings in `.env`.

## 3. Google Drive and Sheets

Use the Google account that should own the diary archive.

For a headless installation, complete this section on your laptop or desktop, outside the SSH session. Use a local checkout of the repository with `npm ci` completed and `.env` prepared. You do not need to start the bot locally.

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Google Drive API** and **Google Sheets API**.
3. Configure the OAuth consent screen. For a personal Google account, choose an external app and add the archive owner's account as a test user during setup.
4. Create an OAuth client with application type **Desktop app**. Download its JSON and save it as `credentials/google-oauth-client.json`.
5. Run `npm run google-auth` on a computer with a browser. Open its printed URL on the same computer, sign in, and approve access.
6. Copy the printed `GOOGLE_DRIVE_ROOT_FOLDER_ID` and `GOOGLE_SHEET_ID` into `.env`.

The helper saves a refresh token in `tokens/google-token.json` and creates a private **Health Diary** folder containing a **Diary Index** Sheet. It requests only the `drive.file` scope, for files created or authorised through this app. Use the helper-created folder and Sheet; arbitrary existing resources may be inaccessible with this scope.

For unattended use, move the OAuth consent app from **Testing** to **Production**. Refresh tokens for an external app in Testing normally expire after seven days with these scopes. See Google's [OAuth setup](https://developers.google.com/identity/protocols/oauth2/native-app), [scope guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), and [token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

### Headless servers

The Debian server does not need a browser or desktop environment. After completing Google sign-in on your computer:

1. Transfer `credentials/google-oauth-client.json` and `tokens/google-token.json` using the [secure transfer commands](deployment.md#2-configure-the-server).
2. Put the helper's printed `GOOGLE_DRIVE_ROOT_FOLDER_ID` and `GOOGLE_SHEET_ID` in the **server's** `.env`.
3. Start the bot on the server. It refreshes Google access automatically using the saved token; no browser is needed for normal operation or restarts.

The setup helper receives Google's sign-in callback on `127.0.0.1`, so run the helper and browser on the same computer for this setup. Choosing a **Desktop app** OAuth client enables this setup flow; it does not require the production bot to run on a desktop. Repeat authorisation only if access expires or is revoked, then replace the server token while writers are stopped.

## Start and verify

Run `npm start`. Send one short voice note from the diary account and check that:

- Telegram replies with the summary.
- Drive contains the audio, transcript, summary and metadata.
- The Sheet's `Entries` tab contains one row with the same summary.
- The administrator's `/status` reports no outstanding problems.

Then follow [server deployment](deployment.md) to install the scheduled jobs. A foreground `npm start` by itself does not install a scheduler.

## Optional configuration

The complete list is in [`.env.example`](../.env.example). Defaults work for the intended single-user setup.

| Setting | Default / behaviour |
| --- | --- |
| `TRANSCRIPTION_MODEL` | `gpt-4o-transcribe` |
| `ENTRY_SUMMARY_MODEL`, `DAILY_SUMMARY_MODEL` | `gpt-4.1-mini` |
| `TIMEZONE` | `Europe/London`; other zones are not supported in v1. |
| `DATA_DIR` | `data`, relative to the working directory. |
| `DIARY_START_DATE` | Blank uses the first application run. Set an ISO date before first use to choose where daily catch-up starts. |
| `RETAIN_LOCAL_AUDIO` | `true`. With `false`, audio is removed only after transcription and verified Drive archival. |
| `GOOGLE_CREDENTIALS_FILE` | `credentials/google-oauth-client.json` |
| `GOOGLE_TOKEN_FILE` | `tokens/google-token.json` |
| `IMMEDIATE_ATTEMPTS`, `RETRY_BASE_MS` | Three attempts, starting with a 1,000 ms backoff. |
| `RETRY_INTERVAL_MS`, `ATTENTION_AFTER_MS` | Retry after 15 minutes; escalate persistent failure after one hour. |
| `HTTP_TIMEOUT_MS` | 120,000 ms. |

Restart the bot after editing `.env`. Scheduled jobs read the file on each invocation.
