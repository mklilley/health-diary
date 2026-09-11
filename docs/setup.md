# Account setup

[Back to the README](../README.md)

Complete the installation commands in the README first. Edit `.env` in a text editor; the bot loads it when it starts. Existing environment variables take precedence over the file.

## 1. Telegram

**For a new bot, no webhook setup is needed.** If you're reusing a bot previously connected to another application, read [reusing an existing Telegram bot](operations.md#reusing-an-existing-telegram-bot) before continuing.

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

## 2. OpenAI

Create an API key in your [OpenAI API account](https://platform.openai.com/api-keys), enable API billing, and put the key in `OPENAI_API_KEY`. A ChatGPT subscription does not supply API access for this bot.

The example configuration selects `gpt-4o-transcribe` for transcription and `gpt-4.1-mini` for summaries. Confirm your API project can use those models, or change the model settings in `.env`.

## 3. Google Drive and Sheets

Use the Google account that should own the diary archive. Complete these steps on a computer with a browser, outside the SSH session, using a local checkout with `npm ci` completed and `.env` prepared.

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Google Drive API** and **Google Sheets API**.
3. Open **Google Auth Platform**. Set the app name (for example, **Health Diary**), choose a support email address you monitor, select **External** for the audience, and enter your developer contact email.
4. Prepare the public pages required for publishing. The repository includes [docs/index.html](index.html), [docs/privacy.html](privacy.html) and [docs/site.css](site.css). Review the privacy policy and host copies of these three files in a public web directory, separate from the bot's private files.
5. In **Branding**, enter the published HTTPS homepage and privacy-policy URLs. Add the site's domain under **Authorized domains**, complete any ownership check Google requests, and save.
6. In **Audience → Publishing status**, click **Publish app → Confirm**. Check the status is **In production before authorising below**: refresh tokens issued in **Testing expire after seven days** for this app. See [Google's publishing-status guidance](https://support.google.com/cloud/answer/15549945).
7. In **Clients**, create an OAuth client with application type **Desktop app**. Download its JSON and save it as `credentials/google-oauth-client.json`.
8. Run `npm run google-auth`. Open its printed URL in a browser on the same computer, sign in with the archive owner's Google account, and approve access.
9. Copy the printed `GOOGLE_DRIVE_ROOT_FOLDER_ID` and `GOOGLE_SHEET_ID` into `.env`.

The helper saves a refresh token in `tokens/google-token.json` and creates a private **Health Diary** folder containing a **Diary Index** Sheet. Use these generated resources: the `drive.file` permission limits access to files created or authorised through this app.

**Already authorised in Testing?** After publishing, rerun `npm run google-auth` to obtain a token issued in Production. Keep the same OAuth client and existing archive IDs in `.env`, then transfer the updated `tokens/google-token.json` to the server. If the bot and jobs are running, stop them before replacing the token and restart them afterwards.

### Headless servers

The Debian server does not need a browser or desktop environment. After completing Google sign-in on your computer:

1. Transfer `credentials/google-oauth-client.json` and `tokens/google-token.json` using the [secure transfer commands](deployment.md#2-configure-the-server).
2. Put the helper's printed `GOOGLE_DRIVE_ROOT_FOLDER_ID` and `GOOGLE_SHEET_ID` in the **server's** `.env`.
3. Start the bot on the server. It refreshes Google access automatically using the saved token; no browser is needed for normal operation or restarts.

There is no need to start the bot immediately after switching to Production. Production refresh tokens have no fixed seven-day expiry, but can still stop working, for example after access is revoked or the token goes unused for six months. See [Google's token-expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

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
