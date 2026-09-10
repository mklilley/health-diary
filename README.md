# Health Diary

A private Telegram voice diary for Matt's sister. Send a voice note; receive `Recorded ✓` followed by one short, faithful summary. Original OGG/Opus audio, the raw transcript and processing metadata remain ordinary files. Google Drive holds the remote archive and one Google Sheet provides an index.

This is the project root. Develop here on macOS; deploy this project's source later to `/srv/health-diary` on Ubuntu. There is no nested project, web server, database, dashboard or production dependency on Codex.

## Before using this for health information

Agree with the diary user which account owns the archive and who can access it. Telegram bot chats are cloud chats, not Signal-style end-to-end encrypted conversations. Telegram receives messages and audio; OpenAI processes audio and transcripts; Google stores the archive and index. Keep the Drive folder and Sheet private, and review each provider's settings and terms. The app creates no public sharing permissions. See [Telegram's explanation of cloud and secret chats](https://telegram.org/faq#q-how-secure-is-telegram).

Summaries are an aid to reading the diary, not medical advice. They must preserve uncertainty and explicit corrections without diagnoses, invented facts or inferred causation. Audio and raw transcripts remain the primary records when a summary is questionable. Transcription itself can make mistakes; corrections should be another voice note.

## How it works

```text
Telegram long polling → authorise private sender → persist entry identity/audio
    → OpenAI transcription → raw transcript.md
    → OpenAI entry summary → summary.md → sister acknowledgement
    → Drive archive + Sheets index → rebuildable aggregate Markdown

PM2: one continuously running bot
systemd: retry every 15 minutes; reminder at 22:00; daily job at 02:00
```

The acknowledgement does not wait for Drive or Sheets to recover. It contains the exact stored entry summary, which is also used unchanged in Drive and the `Entries` tab. Transcription failures receive a brief deferred-processing message; successful later processing sends the normal acknowledgement.

Plain modern JavaScript and Node keep macOS development and Ubuntu production on the same runtime. Built-in filesystem, HTTP, date and test facilities do most of the work. The external dependencies are `openai`, `googleapis` and `proper-lockfile`: official API clients and a shared filesystem writer lock. Application dependencies stay local in `node_modules`; the committed lockfile is installed with `npm ci`. PM2 may be installed globally on the server.

Long polling uses outbound HTTPS only. No domain, public port, reverse proxy, TLS certificate or webhook is needed. Run only one poller for a bot token; stop local development before starting production with that token.

## Accounts, messages and commands

Exactly two distinct positive numeric Telegram user IDs are configured. Usernames are not authorisation. The bot accepts only authenticated private chats, ignoring groups, channels, edited messages and unknown users.

* **Sister:** only Telegram voice notes become diary entries. `/start` and `/help` explain the voice workflow. Ordinary text, photos, audio attachments and other interactions create no diary data.
* **Admin:** voice notes receive a brief explanation and create no diary data. The following commands read the diary or run maintenance.
* **Everyone else:** no diary data, status, archive links or whitelist information is returned.

| Admin command | Meaning |
| --- | --- |
| `/status` | Rebuild and return the same operational view as `data/status/STATUS.md`. |
| `/retry` | Run an immediate retry pass and report checked, resolved, retrying and attention counts. |
| `/day YYYY-MM-DD` | Completed daily summary, or chronological entry summaries while the day is incomplete. Validates the calendar date; never calls AI. |
| `/today` | `/day` using today's London date. |
| `/yesterday` | `/day` using yesterday's London date. |
| `/last` | Most recently completed **daily summary**, not the most recent voice note. |
| `/help` | Admin command help. |

There is no `/skip`, text entry creation or editing an old recording. A correction is a new voice note. The diary uses Telegram's objective message timestamp, converted to `Europe/London`, as its received time. A spoken reference to yesterday belongs to the date the new message was received. Approximate times in speech remain prose, not canonical event timestamps.

## Files and the hierarchy of truth

```text
src/
  bot/                 polling, roles and commands
  jobs/                routine npm entry points and Google OAuth setup
  services/            Telegram, OpenAI, Drive and Sheets adapters
  diary/               entries, days, recovery and derived views
  prompts/             versioned transcription and summary instructions
  util/                dates, atomic writes, locking, retries and safe logging
  config.js            central .env loading and validation
data/                  private runtime state; never deploy from the Mac
  state.json           start date, polling state and shared alert reservations
  telegram.json        next durable Telegram update offset
  entries/YYYY-MM-DD/ENTRY_ID/
    audio.ogg
    transcript.md
    summary.md
    metadata.json
  days/YYYY-MM-DD/
    summary.md
    metadata.json
  aggregates/
    metadata.json      rebuildable aggregate upload state
    all-transcripts.md
    all-entry-summaries.md
    all-daily-summaries.md
  status/
    STATUS.md
    index.json
credentials/           downloaded Google Desktop OAuth client JSON
tokens/                private OAuth refresh-token material
deploy/systemd/        three service/timer pairs for Ubuntu
test/                  automated tests with isolated temporary data
.env                   private configuration
ecosystem.config.cjs   PM2 configuration
```

Entry IDs combine the London received timestamp and Telegram message ID, for example `2026-09-09T14-20-11_001247`. Telegram sender ID plus message ID is the deduplication key; the numeric suffix distinguishes repeated local times during the autumn clock change. Metadata also records the precise timestamp with UTC offset, model names and prompt versions.

The order of authority is:

1. Original audio and raw transcript: primary source material.
2. Entry and daily summaries: derived prose.
3. Sheets, aggregate Markdown and status files: derived views.

Per-entry and per-day metadata are authoritative processing state. Individual source files override aggregates. There is no database because a single-user, low-volume file tree is enough to inspect and recover this system. Do not treat a deleted status file or aggregate as lost diary data; rebuild it. Do not delete metadata to force a retry.

## Durable processing and retries

Every operation persists a state such as `pending`, `running`, `retry`, `attention` or `complete`, with attempt counts, timestamps, safe error classification and retry timing. Important files are written to a temporary sibling, flushed and atomically renamed. Startup and retry scans reconstruct work from disk; an in-memory queue is not required for recovery.

Transient network errors, rate limits and service failures receive a few immediate retries with exponential delay and jitter. Defaults are three immediate attempts, a 15-minute scheduled retry interval and attention after one hour of continuing failure. Invalid credentials and other non-retryable failures need attention sooner. `/retry` and `npm run retry` invoke the same recovery implementation as the timer. The admin `/retry` command forces an immediate pass; the npm command and timer respect persisted `next_retry_at` times. Completed steps are reused instead of being repeated.

The bot and all jobs share a heartbeat-based filesystem lock via `proper-lockfile`; a separate poller lease prevents two local pollers. Use a single local filesystem and one data directory on one machine, with the same Unix account for PM2 and scheduled jobs. Locks update every 10 seconds and become stale after two minutes; a live writer losing its lease exits rather than continuing unprotected. Do not manually delete a lock while any diary process is running, and do not place `data/` on a network share.

Drive uses deterministic names, persisted IDs and reconciliation of uncertain uploads. Sheets checks the unique Entry ID or date before appending, including after a lost response. The local writer lock prevents the bot and timer from racing those checks. Do not run a second machine against the same archive or hand-edit index keys. More than one matching remote object or index row requires inspection instead of choosing one silently.

**External APIs do not provide a transaction covering a local file and a remote request.** If an AI response is lost before the result can be saved, recovery may call the model again and incur another charge. Once a successful summary is saved, it is reused; completed daily summaries are never regenerated automatically.

Telegram does not offer an idempotency key for `sendMessage`. Definite failures may be retried. An acknowledgement whose delivery is ambiguous is held for attention instead of being blindly resent. Reminders and admin notifications reserve delivery in persistent state first, preventing repeated notifications after a crash but allowing a notification to be missed if the process dies before delivery. Inspect the chat and metadata when status reports uncertainty. This is the unavoidable tradeoff between avoiding duplicates and guaranteeing delivery; v1 favours avoiding duplicates for uncertain sends.

Admin alerts are emitted when attention is needed, with a resolution notification after recovery. Shared provider failures are grouped across operations and entries, so one Drive authentication outage produces one alert and one resolution rather than an alert for every file. Reservations live in `data/state.json`; the operation metadata also records notification flags. Repeated retry passes do not repeatedly notify the same unresolved incident. Alerts contain operational identifiers and safe errors, not transcript or summary text. Polling failures also appear in status even when there are no entries yet.

## Reminders and daily summaries

All diary dates and schedules use `Europe/London`, independently of the server's display timezone.

At 22:00, the reminder job checks for any valid received sister voice note on the current London date. A voice note counts immediately, even while transcription or upload is failing. Text and admin activity do not count. Day metadata prevents a second reminder. A delayed invocation may send only while it is still that day's 22:00–24:00 window; it never sends yesterday's missed reminder the next morning. Before deciding there were no entries, the job requires a Telegram backlog drain within the last five minutes on the same day. If polling is unavailable, reminders wait for the bot and the next retry pass, avoiding a false reminder when a voice note is still queued at Telegram.

At 02:00, the daily job attempts to finalise the previous London date and eligible older incomplete dates. It waits for all received notes to have full raw transcripts, then orders those transcripts by received time and makes one daily summary, normally 80–180 words. It never substitutes short entry summaries for raw transcripts. A day with no entries completes with `No entries recorded.`, count `0`, and no AI call. Drive and the `Days` tab receive the completed result.

Before closing a day, the bot must have drained Telegram's backlog beyond the end of that day. The poller advances its durable update offset only after voice-note metadata is saved and records a drained watermark only after proving the backlog is empty. Startup drains that backlog before its initial retry pass. Persisted polling progress lets the daily worker wait while a restarted bot is still receiving old queued messages. Set `DIARY_START_DATE` to the first intended diary date before initialisation; otherwise the first run establishes the start date. Catch-up includes zero-entry days from that start, rather than inventing an unlimited history before the diary existed. Completed days remain immutable, including after retrospective comments and corrections.

The timers use explicit London calendar expressions and `Persistent=true`. London 02:00 and 22:00 exist once on UK clock-change dates. systemd may run one catch-up invocation after downtime; the application scans the eligible date range itself. The reminder's application guard makes its catch-up invocation safe. See the [systemd calendar reference](https://www.freedesktop.org/software/systemd/man/latest/systemd.time.html) and [persistent timer semantics](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html).

**Keep downtime short.** Telegram retains pending updates for no more than 24 hours, and its standard bot file download API limits downloads to 20 MB. Notes that expire in Telegram's queue before this bot receives them cannot be reconstructed from local metadata. Very large voice notes cannot be archived through that API; send shorter recordings. These are upstream constraints, not guarantees the retry worker can overcome. See [Telegram Bot API: updates and getFile](https://core.telegram.org/bots/api).

## Drive, Sheets and local audio

The OAuth setup helper creates a private `Health Diary` root with `entries`, `days` and `aggregates` folders as needed, and a `Diary Index` Google Sheet in that root. Entry and day subfolders mirror the local date/ID structure. Archive files retain stable identities as processing resumes; metadata records their Drive IDs.

| Tab | Columns, in order | Unique key |
| --- | --- | --- |
| `Entries` | Entry ID; Received date/time; Short summary; Audio link; Transcript link | Entry ID |
| `Days` | Date; Daily summary; Number of entries | ISO date |

Summary values are stored as literal cell text, not spreadsheet formulas. The short summary is exactly `summary.md`; no extra medical columns or spreadsheet-specific AI summary are created. Audio and transcript links remain subject to Drive permissions.

`npm run rebuild-aggregates` reconstructs all three aggregate Markdown files from individual local entry/day files, in chronological order. They are portable corpora for later analysis and remain disposable derived views. Normal processing also maintains and archives them. The application creates no second redundant full remote diary backup.

Original recordings remain `audio.ogg`; there is no MP3 conversion. The conservative default retains local audio even after successful transcription and Drive archival. Set `RETAIN_LOCAL_AUDIO=false` only if you want the application to remove local audio after both transcription and its checksum-verified Drive upload succeed. The removal is recorded durably for crash recovery. Raw transcript, entry summary and metadata remain local.

## Local macOS setup

Use **Node 24 LTS** for new installations; `.nvmrc` selects major 24. The package supports Node 22.13 or newer below 27; initial development also runs on Node 22.13/npm 10.9. Prefer an actively supported LTS version and its bundled npm. See [Node release status](https://nodejs.org/en/about/previous-releases) and the [official installation choices](https://nodejs.org/en/download).

From this existing project directory, if you use nvm:

```bash
nvm install
nvm use
node --version
npm --version
npm ci
npm test
umask 077
mkdir -p credentials tokens data
cp -n .env.example .env
chmod 600 .env
chmod 700 credentials tokens data
```

Use `cp -n` only for the first setup; it preserves an existing `.env`. Edit `.env` in a local editor. Do not paste secrets into a shell command, commit them or include them in screenshots. No real credentials are needed for `npm test`, `npm run status`, `npm run rebuild-status`, `npm run rebuild-aggregates` or local day inspection.

### Telegram setup

1. In Telegram, talk to the official `@BotFather`, use `/newbot`, and choose the bot name and username. Put its token in `TELEGRAM_BOT_TOKEN` in `.env`.
2. Disable joining groups with BotFather's `/setjoingroups`. The application also independently rejects group messages.
3. Have both Matt and his sister open the bot's private chat and press **Start**. A bot cannot initiate a conversation with an account that has not started it.
4. Obtain the two numeric user IDs. Before starting the poller, this local command reads pending updates and prints only private sender IDs and names; it does not acknowledge/drop them or print message contents or the bot token:

```bash
node --input-type=module <<'NODE'
import { loadEnvFile } from 'node:process';
loadEnvFile('.env');
const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ timeout: 0, allowed_updates: ['message'] }),
});
const body = await response.json();
if (!body.ok) throw new Error('Telegram setup request failed; check the token and any existing webhook.');
const users = new Map();
for (const update of body.result) {
  const message = update.message;
  if (message?.chat?.type === 'private') users.set(message.from.id, message.from.first_name);
}
for (const [id, name] of users) console.log(id, name);
NODE
```

Set `TELEGRAM_SISTER_USER_ID` and `TELEGRAM_ADMIN_USER_ID` to the correct distinct IDs. If a previous application registered a webhook, remove it using Telegram's `deleteWebhook` with `drop_pending_updates=false` before using long polling. Never run the setup polling command while another poller is active. Telegram's [bot tutorial](https://core.telegram.org/bots/tutorial) explains BotFather and the initial user interaction.

### OpenAI setup

Create an API project with API billing enabled, obtain an API key and set `OPENAI_API_KEY`. A ChatGPT subscription is not the bot's API credential. Set usage/budget alerts in the provider account and confirm access to your selected models.

Defaults are `gpt-4o-transcribe` for transcription and `gpt-4.1-mini` for entry/daily summaries; all three are configurable in `.env`. The audio is uploaded directly as OGG to the cloud transcription endpoint. Text summaries use the Responses API with `store: false`; that setting is not a promise that all provider processing/retention is disabled. Prompt text and versions live in `src/prompts/` and are recorded with the selected models in metadata. See the [transcription API reference](https://platform.openai.com/docs/api-reference/audio/createTranscription) and [API data controls](https://platform.openai.com/docs/guides/your-data).

### Google Cloud and OAuth setup on the Mac

1. Create or choose a Google Cloud project. Enable **Google Drive API** and **Google Sheets API**.
2. Configure Google Auth Platform/OAuth consent. For a personal Gmail account, choose an external app, supply the required app/contact fields, and add the Google account that will own the archive as a test user while developing.
3. Create an OAuth client with application type **Desktop app**. Download its JSON to `credentials/google-oauth-client.json`; do not substitute a service-account key or web client.
4. Request only `https://www.googleapis.com/auth/drive.file`. This is the helper's sole scope, sufficient for the files this app creates, including its Sheet. No full-Drive or separate broad Sheets scope is requested. Arbitrary manually created folders/Sheets may be inaccessible under this scope; use the helper-created resources by default. See [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) and [Sheets scopes](https://developers.google.com/workspace/sheets/api/scopes).
5. Run the helper and open the printed authorisation URL in your browser:

```bash
npm run google-auth
```

The helper uses a temporary loopback listener on `127.0.0.1`, OAuth state, PKCE and offline access. Approve using the archive owner's Google account. The refresh token is saved to `tokens/google-token.json` with restrictive permissions. It creates/reuses an app-owned `Health Diary` folder and `Diary Index`, then prints `GOOGLE_DRIVE_ROOT_FOLDER_ID` and `GOOGLE_SHEET_ID`; paste those IDs into `.env`. It does not share the resources publicly. Repeating setup reconciles the existing resources rather than intentionally creating a second archive. See [Google's installed-app OAuth flow](https://developers.google.com/identity/protocols/oauth2/native-app).

**Before unattended production use, move the OAuth consent app out of Testing into Production.** For an external app in Testing with these scopes, refresh tokens normally expire after seven days. Review Google's current publishing requirements for your chosen account/app; personal use of a non-sensitive scope does not mean every consent warning disappears. Revoked access, token limits and account changes can invalidate even production refresh tokens. Re-run the helper on the Mac when renewed consent is needed, keeping the same configured archive IDs. See [Google refresh-token expiration rules](https://developers.google.com/identity/protocols/oauth2#expiration).

Do not run a second OAuth flow on a production server by exposing the helper's listener publicly. Transfer the completed credential and token files securely instead; see the production steps below.

### Configuration reference

The complete editable example is [`.env.example`](.env.example). The app loads `.env` from its working directory through Node's built-in parser; process environment variables take precedence. PM2 and systemd must use the same working directory, credentials and data directory.

| Variable | Purpose/default |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Required bot secret. |
| `TELEGRAM_SISTER_USER_ID`, `TELEGRAM_ADMIN_USER_ID` | Required distinct numeric private-chat users. |
| `OPENAI_API_KEY` | Required API secret. |
| `TRANSCRIPTION_MODEL` | `gpt-4o-transcribe`. |
| `ENTRY_SUMMARY_MODEL`, `DAILY_SUMMARY_MODEL` | `gpt-4.1-mini`. |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID`, `GOOGLE_SHEET_ID` | Required IDs printed by OAuth setup. |
| `GOOGLE_CREDENTIALS_FILE` | `credentials/google-oauth-client.json`. |
| `GOOGLE_TOKEN_FILE` | `tokens/google-token.json`. |
| `TIMEZONE` | Must be `Europe/London` in v1. |
| `DATA_DIR` | `data`, relative to the project working directory. |
| `DIARY_START_DATE` | Optional inclusive ISO start date; blank establishes the start on first initialisation. |
| `RETAIN_LOCAL_AUDIO` | Defaults to `true`; `false` permits deletion only after transcription and verified Drive archival. |
| `IMMEDIATE_ATTEMPTS` | `3`. |
| `RETRY_BASE_MS` | `1000`, initial exponential retry delay. |
| `RETRY_INTERVAL_MS` | `900000`, persisted background retry delay. |
| `ATTENTION_AFTER_MS` | `3600000`, continued failure threshold. |
| `HTTP_TIMEOUT_MS` | `120000`, provider request timeout. |

Missing required configuration fails startup clearly. The local read/rebuild jobs do not require cloud secrets, although any supplied configuration must still be valid. Leave production paths at their defaults unless you also adjust systemd's `ReadWritePaths` to match.

### Run locally

```bash
npm start
```

Send a short **voice note** from the sister's account. Stop with Ctrl-C. Local testing is real diary processing if configured with real credentials and the production token: use a separate test bot, IDs and app-owned Google archive for live trial data. Do not deploy trial `data/` over production data. Timers are not installed or run automatically on macOS; invoke a job manually when needed:

```bash
npm run status
npm run retry
npm run daily
npm run reminder
npm run day -- 2026-09-09
npm run rebuild-status
npm run rebuild-aggregates
```

`daily` and `reminder` retain their time/date guards even when called manually.

## Tests and validation

```bash
npm ci
npm test
npm run check
```

Tests mock provider boundaries and use isolated temporary directories. Coverage includes the normal voice path, role/privacy checks, duplicate updates, transient and persistent failures, restart recovery, notification suppression, zero-entry days, corrections and retrospective notes, incomplete-day waiting, immutable completed days, aggregate/status rebuilds, commands and London/DST boundaries. They do not require API credentials or send health data to cloud providers.

PM2's configuration is syntax-checked locally. systemd units are templates for Ubuntu; their calendar expressions and unit syntax must also be verified on the actual target as shown below. Neither successful mocks nor source inspection proves that your provider credentials, permissions, selected models or headless deployment are configured correctly.

## First production deployment on Ubuntu

These instructions are to run **later on your chosen Droplet**. No production host, SSH alias or Git remote is assumed. They do not require or create a second archive. Use a maintained Ubuntu release with systemd and a local disk filesystem.

### 1. Install the runtime and an unprivileged account

Install the current Node **24 LTS** with its bundled npm, using the [official Node download/install instructions](https://nodejs.org/en/download), and install `git`, `rsync`, `ca-certificates` and timezone data if absent. For the supplied units, Node must be available system-wide through `/usr/local/bin` or `/usr/bin`. A Node executable installed only inside someone's nvm home is hidden by `ProtectHome=true`; either install a system-wide runtime or deliberately adjust the units to your installation.

Check the executable that the units will see:

```bash
env PATH=/usr/local/bin:/usr/bin:/bin node --version
env PATH=/usr/local/bin:/usr/bin:/bin npm --version
sudo npm install --global pm2
sudo adduser --disabled-password --gecos '' health-diary
sudo install -d -m 750 -o health-diary -g health-diary /srv/health-diary
sudo install -d -m 700 -o health-diary -g health-diary /srv/health-diary/data /srv/health-diary/credentials /srv/health-diary/tokens
```

Create the account/directories only if they do not already exist; use the existing dedicated account if you have one and change all three service files accordingly. Follow your host's SSH policy to enable secure source/credential transfer to that account, or transfer through your existing login and use `sudo install -o health-diary -g health-diary` locally on the server. Do not run the bot as root.

### 2. Transfer source only

The following explicit allowlist copies source and documentation from the **Mac project root**. Replace the host value with your own SSH host or alias. It has no `--delete` and cannot include top-level production `data/`, `.env`, `credentials/`, `tokens/` or `node_modules/` because none is a source argument:

```bash
DIARY_HOST='your-chosen-ssh-host'
rsync -avn src test deploy package.json package-lock.json ecosystem.config.cjs .nvmrc .gitignore .env.example README.md "health-diary@$DIARY_HOST:/srv/health-diary/"
rsync -av src test deploy package.json package-lock.json ecosystem.config.cjs .nvmrc .gitignore .env.example README.md "health-diary@$DIARY_HOST:/srv/health-diary/"
```

Review the dry run first. Keep secrets out of all source/test/deploy files and remove any accidental source-tree symlinks to private directories before transfer. Do not replace this with an unfiltered recursive copy of the project. Alternatively clone a reviewed repository into the project location and use fast-forward pulls; `.gitignore` is essential but is not a defence against already tracked secrets. Never use `git clean -fdx` in production.

### 3. Install dependencies and provision production credentials

As the dedicated server account:

```bash
sudo -iu health-diary
cd /srv/health-diary
umask 077
npm ci
npm test
cp -n .env.example .env
chmod 600 .env
chmod 700 data credentials tokens
```

Edit this **production** `.env` on the server with the appropriate token, IDs, API key and selected start date. Do not copy the Mac `.env` over it during deployment.

Transfer only the two explicitly named Google credential files over SSH, separately from source deployment. For the **first provisioning**, from the Mac:

```bash
scp credentials/google-oauth-client.json "health-diary@$DIARY_HOST:/srv/health-diary/credentials/google-oauth-client.json.incoming"
scp tokens/google-token.json "health-diary@$DIARY_HOST:/srv/health-diary/tokens/google-token.json.incoming"
```

Then, as `health-diary` on the server, preserve existing credentials if present and restrict permissions:

```bash
cd /srv/health-diary
chmod 600 credentials/google-oauth-client.json.incoming tokens/google-token.json.incoming
mv -n credentials/google-oauth-client.json.incoming credentials/google-oauth-client.json
mv -n tokens/google-token.json.incoming tokens/google-token.json
chmod 600 credentials/google-oauth-client.json tokens/google-token.json
```

`mv -n` deliberately does not overwrite existing credentials. If renewing credentials on an existing installation, stop all writers first, compare the intended Google account and configured archive IDs, and replace only the intended token/client file deliberately. Remove unused `.incoming` copies after checking which file is active. Source updates never perform this credential step.

Do not share a production refresh-token file with an independently running local app. Restrict the server account's home and PM2 directory too, because process-manager state and logs are private operational material. The runtime sets a restrictive umask; check existing files inherited from any manual copy:

```bash
chmod 700 /home/health-diary
find data credentials tokens -type d -exec chmod 700 {} +
find data credentials tokens -type f -exec chmod 600 {} +
npm run status
```

### 4. Start PM2 as the dedicated account

Stop any local bot using the same token. Still logged in as `health-diary`:

```bash
cd /srv/health-diary
umask 077
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
pm2 status
pm2 logs health-diary-bot --lines 50
```

Run the exact privileged startup command printed by `pm2 startup` from an account with sudo access; it should name `health-diary` and `/home/health-diary`. This generates PM2's boot service. **Do not create another handwritten systemd service for the bot.** `ecosystem.config.cjs` runs one forked instance, restarts with increasing delay, disables file watching and permits a graceful stop. After repeated rapid crashes PM2 can mark it errored; fix the configuration and restart it.

Verify PM2's saved process list belongs to the dedicated account, not root. Restarting a different user's PM2 daemon does not control this bot. Node upgrades may require regenerating PM2's startup command; see [PM2 boot and Node-upgrade instructions](https://pm2.keymetrics.io/docs/usage/startup/).

### 5. Install and verify the six systemd files

From an administrator shell on the server, inspect the templates, especially the Unix user, runtime `PATH` and write paths. The services load `.env` through the application, just as PM2 does, rather than using a different systemd env-file parser.

```bash
cd /srv/health-diary
sudo systemd-analyze verify deploy/systemd/health-diary-*.service deploy/systemd/health-diary-*.timer
systemd-analyze calendar '*-*-* *:00/15:00 Europe/London'
systemd-analyze calendar '*-*-* 22:00:00 Europe/London'
systemd-analyze calendar '*-*-* 02:00:00 Europe/London'
sudo install -m 644 deploy/systemd/health-diary-retry.service deploy/systemd/health-diary-retry.timer /etc/systemd/system/
sudo install -m 644 deploy/systemd/health-diary-reminder.service deploy/systemd/health-diary-reminder.timer /etc/systemd/system/
sudo install -m 644 deploy/systemd/health-diary-daily.service deploy/systemd/health-diary-daily.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now health-diary-retry.timer health-diary-reminder.timer health-diary-daily.timer
systemctl list-timers 'health-diary-*'
sudo systemctl start health-diary-retry.service
sudo journalctl -u health-diary-retry.service -n 50 --no-pager
```

The service templates allow writes only to `/srv/health-diary/data` and `/srv/health-diary/tokens`, keep the home directory hidden and use umask `0077`. Both write directories must exist before starting a service. They permit up to 45 minutes for a one-shot pass and never run multiple instances of the same unit concurrently; the application lock also coordinates different jobs with the bot. Large recovery backlogs may need several passes. `Persistent=true` requires accurate system time; ensure time synchronisation is enabled.

## Safe application updates

Production state survives source updates. Keep the project directory, production `.env`, credential/token files and `data/` in place. Review source changes and tests on the Mac first.

1. On the server, stop the three timers and any active one-shot services. Then, as `health-diary`, stop the PM2 bot. This prevents a mixed-version process from continuing while files change:

```bash
sudo systemctl stop health-diary-retry.timer health-diary-reminder.timer health-diary-daily.timer
sudo systemctl stop health-diary-retry.service health-diary-reminder.service health-diary-daily.service
sudo -iu health-diary
cd /srv/health-diary
pm2 stop health-diary-bot
```

2. Copy only the allowlisted source from the Mac using the same dry-run/rsync commands above, or use a reviewed fast-forward source pull. There is no blanket deletion of removed files; inspect and remove a retired **source file** explicitly if a release requires it. Never remove the project directory to deploy a new version.
3. As `health-diary`, run `npm ci`, `npm test`, and `npm run status`. Inspect new `.env.example` options and edit production `.env` deliberately if required; never overwrite it with the example.
4. If unit templates changed, verify them and install only these six named files, then `sudo systemctl daemon-reload`. Restart the bot as `health-diary`, save its process list, then restart the timers from the administrator shell:

```bash
cd /srv/health-diary
pm2 restart ecosystem.config.cjs --only health-diary-bot --update-env
pm2 save
npm run retry
```

```bash
sudo systemctl start health-diary-retry.timer health-diary-reminder.timer health-diary-daily.timer
systemctl list-timers 'health-diary-*'
```

Review status and one test voice note after the update. Roll back source and its matching lockfile if needed, leaving diary data in place; inspect any documented metadata schema changes before downgrading. This v1 deployment deliberately uses a transparent manual procedure, not a script with remote assumptions or deletion rules.

## Status, failures and recovery

Routine application logs contain operation names, IDs, attempts and safe error codes, not raw transcripts, summaries, credentials or token-bearing URLs. `status` is an operational view. Commands that explicitly display a day and files opened directly contain private health data; use a private terminal and do not paste them into public support tickets.

| Symptom | What to do |
| --- | --- |
| Voice accepted but archive still pending | Run `npm run status`, inspect the entry's metadata, restore provider access and run `npm run retry`. Saved transcript/summary will be reused. |
| Google auth attention | Check revoked consent, Testing-mode expiry and account permissions; renew OAuth on the Mac and deliberately install the token on the stopped server. |
| OpenAI attention | Check API billing, key permissions and availability of configured models; fix `.env`, restart PM2 and retry. |
| Telegram conflict/polling fails | Confirm no local or second PM2 poller uses the same token, and no webhook remains configured. |
| Bot cannot message sister/admin | Each must press Start in its private chat and must not have blocked the bot. Check the configured numeric IDs. |
| Daily summary remains waiting | Check pending transcripts and bot polling progress. A stopped bot cannot drain old Telegram updates. Restore it and retry; do not create a partial daily summary manually. |
| Missing or stale `STATUS.md`/aggregates | Rebuild from the authoritative entry/day files. No API call is needed for a local rebuild. |
| Ambiguous Telegram acknowledgement | Inspect the actual private chat and the entry's delivery state. Do not reset it and retry blindly: the recipient may already have the summary. |
| Duplicate Drive candidates or Sheets keys | Inspect the remote objects and local IDs before repair; do not delete local source records or remove arbitrary remote rows. |
| Permission or lock error | Confirm the bot/jobs use the same account and data directory. Allow stale-lock recovery after stopped/crashed writers; never delete a live writer's lock. |
| Disk full or damaged JSON | Stop writers, free unrelated disk space and preserve the affected files. Recover known-good source/metadata from Drive where available; do not substitute an empty JSON object. |

For interruption during an upload, leave metadata intact and run a retry pass after the bot is back. The worker discovers completed local artifacts and reconciles remote outcomes. Corrupt or missing primary files require human recovery; status rebuild cannot recreate missing source material.

An ambiguous acknowledgement needs a deliberate delivery decision. First stop timers, active jobs and PM2 using the update procedure. Inspect the sister's actual chat and the relevant `metadata.json`. If the exact summary is present, change only `steps.telegram_acknowledgement` to `status: "complete"`, set a truthful `completed_at`/message ID if known, clear `next_retry_at` and remove `ambiguous_delivery`. If the sister confirms it was not delivered and you want one fresh attempt, change only that step to `status: "retry"`, clear `next_retry_at` and remove `ambiguous_delivery`. Preserve attempt history and all source/AI steps. Save valid JSON atomically, then restart the bot and run a retry. If delivery cannot be established, leave it for attention. Never clear a reminder's reserved flag to try to force another reminder on the same date.

If the server's data disk is lost, Drive is the remote diary archive. Stop all writers, securely download the archived `entries/` and `days/` trees with original filenames into a new local `data/`, restore production credentials separately, and inspect the recovered metadata/Drive IDs before resuming. Rebuild local status and aggregates, then retry. Review Telegram polling/acknowledgement state and the configured start date before reconnecting: a remote snapshot is not an exactly current copy of every local delivery reservation. There is no automated disaster-restore command in v1, and Drive cannot recover files that never successfully uploaded.

## Things Matt Will Forget Six Months From Now

* Run PM2 commands as **health-diary**. Root's PM2 process list is different.
* The directory is `/srv/health-diary`, even if the original local project was called `heath-diary`.
* `.env` changes need a PM2 restart. systemd jobs load the file on their next invocation. Exported process variables override `.env`; remove an old export if editing the file seems ineffective.
* `/last` is a daily summary. `/today` is usually a list of entry summaries until the next day's finalisation.
* Sending a text correction does not change the diary. Send another voice note.
* The 22:00 reminder counts received voice notes, including failed processing. `/skip` does not exist.
* A completed daily summary is frozen. Prompts/model changes affect future generations, not history.
* Google consent left in Testing can break the bot after seven days. Refresh tokens are secrets, and a downloaded OAuth client JSON alone is insufficient.
* Source deployment excludes `.env`, `credentials/`, `tokens/`, `data/` and `node_modules/`. Use `npm ci` on the server.
* Never use `git clean -fdx`, `rsync --delete` on the whole project, or a fresh recursive project copy as an update shortcut.
* Do not run the same Telegram bot token on the Mac and Droplet at the same time.
* Keep original audio, metadata and raw transcripts. Aggregates, Sheets and status are convenient views.
* Ordinary logs intentionally omit health content. Looking at a day file does not.
* Check Google/OpenAI billing, available disk space, active timers and PM2 startup after host maintenance. A green PM2 process alone does not prove archive operations are succeeding.

As `health-diary`:

```bash
cd /srv/health-diary
pm2 status
pm2 logs health-diary-bot --lines 50
pm2 restart health-diary-bot
npm run status
npm run retry
npm run day -- 2026-09-09
npm run rebuild-status
npm run rebuild-aggregates
cat data/status/STATUS.md
ls data/entries/2026-09-09/
ls data/days/2026-09-09/
```

From an administrator shell:

```bash
systemctl status health-diary-retry.timer
systemctl status health-diary-reminder.timer
systemctl status health-diary-daily.timer
systemctl list-timers 'health-diary-*'
sudo journalctl -u health-diary-retry.service -n 50 --no-pager
sudo journalctl -u health-diary-reminder.service -n 50 --no-pager
sudo journalctl -u health-diary-daily.service -n 50 --no-pager
```

## Required live acceptance checks

The implementation can be tested locally without secrets. Before trusting the deployed diary, perform these checks with the intended accounts and a short clearly identified trial voice note; live provider credentials and the Droplet are required.

1. Both users press Start. Confirm the sister sees only her help, Matt sees admin help, an unknown account receives no diary data, and a group cannot access anything.
2. Send a sister voice note. Confirm original `audio.ogg` is playable, `transcript.md` is faithful, `summary.md` is prose only, the Telegram acknowledgement contains that exact summary, Drive contains all four entry artifacts and `Entries` has exactly one row with the same summary and private working links.
3. Send sister text and an admin voice note; confirm neither creates an entry. Send a correction as a new voice note and confirm the older files stay unchanged.
4. Temporarily remove archive access in a controlled test setup. Confirm the sister still gets the successful summary, local records remain, retry/attention is visible and restoring access followed by a retry completes without duplicate files/rows.
5. Stop/restart the process during a controlled pending operation. Confirm saved work resumes and an uncertain Telegram send is surfaced rather than repeatedly resent. Check attention and resolution notifications once each using the test setup.
6. Across real London dates, confirm the 22:00 zero-entry reminder occurs once, a received voice suppresses it, and a morning catch-up does not send yesterday's reminder. Confirm the 02:00 daily summary uses every complete raw transcript and includes zero-entry days without AI generation.
7. On Ubuntu, validate the six units and schedules, check timer logs and PM2 boot startup, and reboot once during commissioning. Confirm catch-up waits for the poller, then completes due days without regenerating already completed summaries.
8. Inspect private Drive permissions, file ownership/modes, Git ignored files and logs. Stop local polling before production use. Review the trial records deliberately instead of deleting metadata while a process is running.
