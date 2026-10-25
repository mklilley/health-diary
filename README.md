# Health Diary

A self-hosted Telegram bot that turns voice notes into a personal health diary. It transcribes each recording, replies with a short summary, and archives the audio and text in Google Drive. Google Sheets provides a searchable index.

The bot supports **multiple separate diaries and one administrator**, in private Telegram chats. The administrator can also keep a diary. Diary dates and schedules use **Europe/London**.

## Requirements

- Node.js 24, npm and Git.
- A Telegram bot and the Telegram accounts that will use it.
- An OpenAI API key with API billing enabled, and a Google account with a Google Cloud project.

The setup commands below use a macOS or Linux terminal. The [server guide](docs/deployment.md) targets Debian and also applies to Ubuntu.

## Install and run

### 1. Download and install

```bash
git clone https://github.com/mklilley/health-diary.git
cd health-diary
npm ci
umask 077
mkdir -p credentials tokens
cp -n .env.example .env
cp -n users.example.json users.json
chmod 600 .env users.json
```

If you use nvm, run `nvm install && nvm use` before `npm ci`.

### 2. Connect your accounts

Follow the [account setup guide](docs/setup.md) to:

1. Create a Telegram bot, enter its token and administrator ID in `.env`, and list diary users in `users.json`.
2. Add your OpenAI API key to `.env`.
3. Enable the Google Drive and Sheets APIs and download a Desktop OAuth client to `credentials/google-oauth-client.json`.

Run this in a local checkout on a computer with a browser. **For a headless server, do this step on your laptop or desktop, outside the SSH session:**

```bash
npm run google-auth
```

Open the printed URL on that same computer and approve access. The helper creates a private Drive root folder. Copy the root ID it prints into `.env`. Each diary gets its own folder and Sheet as needed.

For a headless installation, [transfer the saved Google credentials to the server](docs/setup.md#headless-servers). The server uses them without a browser during normal operation.

### 3. Start the bot

```bash
npm start
```

Each user must open the bot and press **Start**. Send a voice note from an account listed in `users.json`; the bot should reply with `Recorded ✓` and a summary. From the administrator's account, open `/admin`, select the person, then tap **Status**.

The bot runs until you stop it with Ctrl-C. For continuous operation, automatic retries, daily summaries and reminders, follow [server deployment](docs/deployment.md). If PM2 is already running under your own account, add [scheduled jobs with cron](docs/cron.md), without sudo. Run only one copy with a given bot token.

## Using the diary

Only approved users' **voice notes** create entries. Recordings always belong to the sender, including an administrator listed in `users.json`. Text messages are not diary entries. Send corrections as new voice notes; previous entries stay unchanged.

With scheduled jobs installed, the bot checks for a no-entry reminder from **22:00** and summarises the previous day from **02:00**, London time. Processing or downtime can delay completion.

Open **admin** from Telegram's command menu (or send `/admin`), choose a person, and use **Today**, **Latest day**, **Choose date**, **Export**, **Status** or **Retry pending**. **Switch person** changes the selection; **Close** clears it. Ordinary users only record entries. [Menu and configuration details](docs/multi-user.md).

**Latest day** skips empty days. It shows the completed daily summary when available, otherwise the saved entry summaries with processing still pending marked.

Use **Export** when you need that person's saved transcripts and summaries together for analysis. It makes no AI calls. Combined files stay unchanged until the next export; individual records and daily summaries continue to be saved automatically.

## Privacy and storage

Telegram bot chats are **not end-to-end encrypted**. Telegram, OpenAI and Google process or store diary content. Keep the archive private and use the bot only with the diary user's agreement.

Local records live in `data/users/<Telegram-ID>/`. Keep `.env`, `users.json`, `credentials/`, `tokens/` and `data/` out of Git and preserve them during updates. Summaries can be inaccurate; recordings and transcripts are the source records.

## Further help

- [Account setup and configuration](docs/setup.md)
- [Debian server deployment and updates](docs/deployment.md)
- [Storage, retries and troubleshooting](docs/operations.md)

Run `npm test` to check the application with mocked APIs; no credentials are needed.
