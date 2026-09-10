# Health Diary

A self-hosted Telegram bot that turns voice notes into a personal health diary. It transcribes each recording, replies with a short summary, and archives the audio and text in Google Drive. Google Sheets provides a searchable index.

The bot supports **one diary user and one separate administrator**, in private Telegram chats. Diary dates and schedules currently use **Europe/London**.

## Requirements

- Node.js 24, npm and Git.
- A Telegram bot and two Telegram accounts: the diary user and administrator.
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
chmod 600 .env
```

If you use nvm, run `nvm install && nvm use` before `npm ci`.

### 2. Connect your accounts

Follow the [account setup guide](docs/setup.md) to:

1. Create a Telegram bot and enter its token and both user IDs in `.env`.
2. Add your OpenAI API key to `.env`.
3. Enable the Google Drive and Sheets APIs and download a Desktop OAuth client to `credentials/google-oauth-client.json`.

Run this in a local checkout on a computer with a browser. **For a headless server, do this step on your laptop or desktop, outside the SSH session:**

```bash
npm run google-auth
```

Open the printed URL on that same computer and approve access. The helper creates a private Drive folder and Sheet. Copy the two Google IDs it prints into `.env`.

For a headless installation, [transfer the saved Google credentials to the server](docs/setup.md#headless-servers). The server uses them without a browser during normal operation.

### 3. Start the bot

```bash
npm start
```

Both Telegram users must open the bot and press **Start**. Send a voice note from the diary user's account; the bot should reply with `Recorded ✓` and a summary. Send `/status` from the administrator's account to check processing.

The bot runs until you stop it with Ctrl-C. For continuous operation, automatic retries, daily summaries and reminders, follow [server deployment](docs/deployment.md). Run only one copy with a given bot token.

## Using the diary

Only the diary user's **voice notes** create entries. Text messages and administrator recordings are not stored as diary entries. Send corrections as new voice notes; previous entries stay unchanged.

With scheduled jobs installed, the bot sends a no-entry reminder at **22:00** and summarises the previous day at **02:00**, London time.

| Administrator command | Purpose |
| --- | --- |
| `/status` | Check processing and failures. |
| `/retry` | Retry outstanding work now. |
| `/today`, `/yesterday`, `/day YYYY-MM-DD` | View a day. |
| `/last` | View the latest completed daily summary. |
| `/help` | Show commands. |

## Privacy and storage

Telegram bot chats are **not end-to-end encrypted**. Telegram, OpenAI and Google process or store diary content. Keep the archive private and use the bot only with the diary user's agreement.

Local records live in `data/`. Keep `.env`, `credentials/`, `tokens/` and `data/` out of Git and preserve them during updates. Summaries can be inaccurate; recordings and transcripts are the source records.

## Further help

- [Account setup and configuration](docs/setup.md)
- [Debian server deployment and updates](docs/deployment.md)
- [Storage, retries and troubleshooting](docs/operations.md)

Run `npm test` to check the application with mocked APIs; no credentials are needed.
