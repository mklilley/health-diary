# Debian deployment

[Back to the README](../README.md)

This guide targets Debian with systemd and also applies to Ubuntu. It runs one bot under PM2 and three scheduled jobs under systemd, using `/srv/health-diary` and a dedicated `health-diary` Unix account. No public web port, domain or reverse proxy is needed.

Commands assume an administrator account with `sudo`. If logged in as root, omit `sudo` and use `su - health-diary` instead of `sudo -iu health-diary` when switching to the application account.

## 1. Install the application

Install Node.js 24, npm and Git. Node must be available through `/usr/local/bin` or `/usr/bin` for the supplied services; an installation inside another user's home directory will not work with their `ProtectHome` setting.

Check the version available to the services before proceeding:

```bash
env PATH=/usr/local/bin:/usr/bin:/bin node --version
env PATH=/usr/local/bin:/usr/bin:/bin npm --version
```

Use Node 24 for this guide. Debian's default `nodejs` package may be too old: [Debian 12 packages Node 18](https://packages.debian.org/bookworm/nodejs) and [Debian 13 packages Node 20](https://packages.debian.org/trixie/nodejs), both below this application's minimum of 22.13. Installing `nodejs` from the default repositories alone is therefore insufficient on those releases.

Run as a server administrator on a fresh installation:

```bash
sudo npm install --global pm2
sudo adduser --disabled-password --gecos '' health-diary
sudo install -d -m 750 -o health-diary -g health-diary /srv/health-diary
sudo -iu health-diary
git clone https://github.com/mklilley/health-diary.git /srv/health-diary
cd /srv/health-diary
umask 077
npm ci
npm test
mkdir -p data credentials tokens
cp -n .env.example .env
chmod 700 data credentials tokens
chmod 600 .env
```

Reuse the account if it already exists. Clone only into an empty directory; use the update procedure below for an existing installation.

## 2. Configure the server

Follow [account setup](setup.md) and fill in the server's `.env`. **The server does not need a browser.** Complete [Google authorisation on your laptop or desktop](setup.md#headless-servers), outside the SSH session, then transfer these two files securely:

- `credentials/google-oauth-client.json`
- `tokens/google-token.json`

Also put the two Google IDs printed by the helper into the server's `.env`. The saved refresh token lets the bot access Google unattended, including after a reboot.

If the dedicated account accepts SSH, run this from the computer where you completed OAuth, replacing `your-server` with your own host:

```bash
scp credentials/google-oauth-client.json health-diary@your-server:/srv/health-diary/credentials/google-oauth-client.json.incoming
scp tokens/google-token.json health-diary@your-server:/srv/health-diary/tokens/google-token.json.incoming
```

Otherwise use your normal SSH account and install the files with owner `health-diary`. As `health-diary` on the server:

```bash
cd /srv/health-diary
chmod 600 credentials/google-oauth-client.json.incoming tokens/google-token.json.incoming
mv -n credentials/google-oauth-client.json.incoming credentials/google-oauth-client.json
mv -n tokens/google-token.json.incoming tokens/google-token.json
npm run status
```

The `mv -n` commands preserve existing credentials. If renewing access, stop the bot and jobs first, deliberately replace the required file, and remove unused `.incoming` copies. Keep `DATA_DIR=data` unless you also adjust the services' `ReadWritePaths`.

## 3. Start the bot with PM2

Stop any other copy using the same Telegram token. As `health-diary`:

```bash
cd /srv/health-diary
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
pm2 status
pm2 logs health-diary-bot --lines 50
```

Run the privileged command printed by `pm2 startup` from an administrator shell. It should target the `health-diary` user. PM2 creates its own boot service; no separate bot service is needed. Send a test voice note and check `/status` before proceeding.

## 4. Enable the scheduled jobs

From a server administrator shell:

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
```

| Job | London schedule |
| --- | --- |
| Retry | Every 15 minutes |
| No-entry reminder | 22:00 |
| Previous-day summary | 02:00 |

The services run as `health-diary`, load the same `.env` as the bot, and can write only to `data/` and `tokens/`. All three timers catch up after downtime; application date checks prevent stale reminders and regenerated summaries.

Confirm `/status`, timer logs and PM2 startup after a reboot. See [troubleshooting](operations.md) if processing remains incomplete.

## Updating an installation

Preserve `data/`, `.env`, `credentials/` and `tokens/`. Do not replace the entire project directory or copy another installation's runtime files over it.

First stop scheduling and active jobs, then stop the bot. From an administrator shell:

```bash
sudo systemctl stop health-diary-retry.timer health-diary-reminder.timer health-diary-daily.timer
sudo systemctl stop health-diary-retry.service health-diary-reminder.service health-diary-daily.service
sudo -iu health-diary
cd /srv/health-diary
pm2 stop health-diary-bot
git status --short
```

Inspect local changes before pulling and resolve them deliberately if needed. Then, as `health-diary`:

```bash
git pull --ff-only
npm ci
npm test
npm run status
```

Review new configuration options; do not overwrite `.env` with the example. If unit files changed, verify and reinstall them using step 4.

As `health-diary`, restart the bot:

```bash
pm2 restart ecosystem.config.cjs --only health-diary-bot --update-env
pm2 save
```

From an administrator shell, restart the timers:

```bash
sudo systemctl start health-diary-retry.timer health-diary-reminder.timer health-diary-daily.timer
```

Check `/status` and send a test voice note. Never use `git clean -fdx` or a whole-project `rsync --delete` to update this application.
