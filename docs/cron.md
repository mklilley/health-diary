# Scheduled jobs with cron

[Back to the README](../README.md)

Use this option for an installation under your existing Unix account. It needs a running cron service and permission to edit your own crontab; no sudo or systemd user timers are needed. Keep PM2 running the Telegram bot as before.

Run every command below from the repository directory, as the same account that runs PM2. Complete [account setup](setup.md) and test the bot first.

## Enable scheduling

Check that cron is running, then print the entry for this installation:

```bash
systemctl is-active cron
npm run --silent cron:print
crontab -e
```

The first command should print `active`. If cron is inactive, a server administrator needs to start it. Copy the single line printed by `cron:print` into the editor, keeping your existing cron entries, then save and exit. Add it only once.

The generated line uses absolute paths to this checkout and your current Node executable, including an nvm installation. Regenerate and replace that line if you move the checkout or change the Node installation.

**One entry runs every 15 minutes.** The existing retry pass handles all scheduled work:

- Retry unfinished operations and catch up overdue daily summaries.
- Check the no-entry reminder from 22:00 until midnight, London time.
- Finalise the previous day from 02:00, London time.

Cron also retries failed uploads from an administrator-requested `/export`. It never generates new combined files; those remain snapshots until the next `/export`.

These date checks happen inside the application. The schedule works through GMT/BST changes even when the server uses UTC; no cron timezone setting is required. Pending work is checked on the next pass after downtime. Work may be delayed by ongoing processing or unavailable providers; previous-day reminders are never sent late.

Use cron **or** the systemd timers. If the Health Diary timers are already enabled, have an administrator stop and disable them and stop any active Health Diary job services before enabling cron. The cron pause command does not control systemd timers.

## Check it works

Run a pass now and inspect its log:

```bash
npm run cron
tail -n 50 logs/cron.log
npm run status
```

Look for `cron_finished`; failures are recorded as `cron_failed`. Also check the log after the next quarter-hour to confirm cron itself invoked it. Closing SSH does not stop scheduling. After a server reboot, check that both PM2 and cron have resumed.

The runner loads the repository's `.env`, skips a pass if another scheduled pass is running, and limits each pass to 45 minutes. Logs are private and rotate before a pass when `logs/cron.log` reaches 5 MiB, keeping one previous file as `logs/cron.log.1`. A pass interrupted by the time limit can recover through the application's normal retry mechanism.

## Updating an installation

Pause cron and wait for any active scheduled pass to finish, then stop the bot with watching disabled:

```bash
npm run cron:pause
pm2 stop health-diary-bot --watch
git status --short
```

Resolve any local changes before updating. Preserve `.env`, `credentials/`, `tokens/` and `data/`:

```bash
git pull --ff-only
npm ci
npm test
npm run status
```

After those checks succeed, recreate the PM2 registration to apply the ecosystem settings, then resume cron:

```bash
pm2 delete health-diary-bot
pm2 start ecosystem.config.cjs --only health-diary-bot
pm2 save
npm run cron:resume
```

`pm2 delete` removes the process registration, not your files. Check `/status` and the next cron log entry. The pause persists across reboots and updates until you run `cron:resume`, so leave it paused if an update fails. To remove scheduling entirely, use `crontab -e` and remove only the Health Diary entry.

See [Debian's crontab documentation](https://manpages.debian.org/trixie/cron/crontab.5.en.html) for the schedule syntax.
