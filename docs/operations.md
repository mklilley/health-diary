# Operations and troubleshooting

[Back to the README](../README.md)

## Routine commands

Run these from the repository directory. On a server, use the `health-diary` Unix account for npm and PM2 commands.

```bash
npm run status
npm run retry
npm run day -- 2026-09-09
npm run rebuild-status
npm run rebuild-aggregates
pm2 status
pm2 logs health-diary-bot --lines 50
pm2 restart health-diary-bot
```

The status, day and rebuild commands work without cloud credentials. `npm run retry` respects saved retry times; Telegram's `/retry` forces an immediate pass. To inspect scheduled jobs from an administrator shell:

```bash
systemctl list-timers 'health-diary-*'
sudo journalctl -u health-diary-retry.service -n 50 --no-pager
sudo journalctl -u health-diary-reminder.service -n 50 --no-pager
sudo journalctl -u health-diary-daily.service -n 50 --no-pager
```

## Where records live

| Path | Contents |
| --- | --- |
| `data/entries/YYYY-MM-DD/ENTRY_ID/` | `audio.ogg`, `transcript.md`, `summary.md`, `metadata.json` |
| `data/days/YYYY-MM-DD/` | Daily `summary.md` and `metadata.json` |
| `data/aggregates/` | Combined transcripts, entry summaries and daily summaries; upload state |
| `data/status/STATUS.md` | Human-readable processing status |
| `data/status/index.json` | Rebuildable status cache |
| `data/state.json` | Start date, polling state and shared alert reservations |
| `data/telegram.json` | Durable Telegram update offset |

Drive mirrors the entry, day and aggregate folders. The Sheet has an `Entries` tab with entry ID, received time, the exact stored short summary, audio link and transcript link. Its `Days` tab has date, daily summary and entry count.

Audio and raw transcripts are primary records. Per-entry and per-day metadata control processing. Summaries are derived; status, Sheets and aggregates are views. Local audio stays by default. With `RETAIN_LOCAL_AUDIO=false`, it can be removed only after transcription and verified Drive archival.

Deleting a status file or aggregate does not lose primary records: rebuild it. Missing or corrupt primary files require repair; the application will not silently replace a good aggregate with incomplete source material. Never delete metadata to force a retry.

## Processing and recovery

The application uses plain JavaScript, the OpenAI and Google API clients, and a filesystem lock. Files are written atomically. Each operation records `pending`, `running`, `retry`, `attention` or `complete`, along with attempts, timestamps and safe errors.

Failed work survives a restart. Saved transcripts and summaries are reused. Drive reconciles uploads by name, ID and checksum; Sheets checks entry IDs or dates before appending. An AI request may be repeated if its response was lost before being saved.

Transient errors get three immediate attempts by default, then scheduled retries. Persistent failures escalate after an hour; authentication or configuration errors escalate sooner. Shared provider problems produce one admin alert and a resolution message after recovery.

Run one installation against each bot token and archive. Bot and scheduled jobs must share the same local data directory and Unix account. Filesystem locks update every ten seconds and become reclaimable two minutes after a crash. Do not remove a live lock or place the data directory on a network filesystem.

Ordinary logs omit health content and secrets. Explicit day-view commands and source files contain private diary material.

## Reminder and daily-summary rules

- A received diary voice note counts towards the reminder even if processing fails. Text and administrator activity do not count.
- Reminders send only between 22:00 and midnight on the current London date, after a recent successful poll. A previous day's missed reminder is not sent the next morning.
- Daily summaries use all full transcripts in received order. Incomplete transcription or an undrained Telegram backlog delays finalisation.
- Catch-up begins at the saved diary start date. Zero-entry days complete without an AI call.
- Completed daily summaries stay unchanged. Corrections and retrospective comments belong to the new voice note's received date.

Telegram retains queued updates for no more than 24 hours, and its standard bot download API limits files to 20 MB. Notes that expire before receipt cannot be recovered locally; use shorter voice notes for oversized recordings. See the [Telegram API limits](https://core.telegram.org/bots/api).

## Common problems

| Problem | Action |
| --- | --- |
| Startup reports missing configuration | Fill the named setting in `.env`; restart the bot. |
| Google authentication fails | Check consent, token expiry and archive permissions. Renew OAuth using the [setup guide](setup.md), then replace the server token while writers are stopped. |
| OpenAI requests fail | Check API billing, key permissions and configured model access. |
| Telegram polling conflicts | Stop other bot instances and remove any existing webhook. |
| Bot cannot message an account | The account must press Start and must not have blocked the bot. Check its numeric ID. |
| Daily summary stays waiting | Check pending transcripts and whether the bot is polling successfully. |
| Archive operation remains pending | Restore provider access and retry; keep the local source files. |
| Duplicate remote files or Sheet keys | Inspect matching objects and saved IDs before repairing them. |
| Permission or lock error | Check the process account and data directory. Allow stale locks to recover after stopped processes. |
| Disk full or corrupt files | Stop writers, preserve affected files, free space and restore known-good records from Drive where available. |

## Uncertain Telegram delivery

Telegram cannot guarantee exactly one delivery after a lost response. The bot holds uncertain acknowledgements for attention instead of resending automatically. Reminder and admin-alert reservations prevent duplicates but may leave a message undelivered if a crash happens before sending.

For an uncertain acknowledgement, stop all writers using the [update procedure](deployment.md#updating-an-installation). Check the actual chat and the entry's `metadata.json`:

- If the exact summary arrived, set `steps.telegram_acknowledgement.status` to `complete`, record a truthful completion time/message ID if known, clear `next_retry_at` and remove `ambiguous_delivery`.
- If the recipient confirms it did not arrive, set that step to `retry`, clear `next_retry_at` and remove `ambiguous_delivery` to permit a new attempt.
- If delivery cannot be established, leave it for attention.

Preserve attempts and every source/AI step. Save valid JSON atomically, then restart. Never clear a reminder reservation to force another reminder for the same day. Shared admin-alert reservations live in `data/state.json`.

## Restoring a lost data directory

Stop all writers. Securely restore the archived `entries/` and `days/` trees from Drive into `data/`, preserving filenames. Restore credentials separately, then inspect metadata, Drive IDs, the diary start date and Telegram delivery state before reconnecting. Rebuild status and aggregates, then retry.

Remote metadata is a snapshot and may lag local delivery reservations. Review uncertain sends before resuming. There is no automated disaster-restore command, and Drive cannot recover files that never uploaded.

## Checks before relying on an installation

`npm test` uses mocked providers. With the intended accounts, verify a short voice note reaches all destinations with the same summary, role restrictions work, corrections append new records, and a restart resumes pending work. On the server, check a real reminder and daily summary, timer logs, private archive permissions, and PM2 startup after reboot.
