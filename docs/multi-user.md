# Multi-user implementation checkpoints

This work is in progress. Keep existing installations on the single-user release until the admin menu and migration are ready. Do not change the server's `.env` or move diary files yet.

1. **Diary isolation (complete):** user registry, separate local and Drive storage, admin diary membership, and per-person processing, retries, reminders and daily summaries.
2. **Telegram interface (current checkpoint):** visual admin menu with an explicit diary selection. Voice notes always belong to the sender. Ordinary diary users cannot view or export records through commands.
3. **Migration and setup:** dry-run and resumable migration, configuration updates, generated Drive owner labels, and deployment instructions.

## Configuration being introduced

The private `users.json` file lists allowed diary users. Copyable examples are in `users.example.json`:

```json
[
  { "telegramUserId": 123456789, "label": "Alex" },
  { "telegramUserId": 987654321, "label": "Sam" }
]
```

`.env` will use `DIARY_USERS_FILE=users.json` and retain `TELEGRAM_ADMIN_USER_ID`. The admin may also appear in `users.json`. The bot token, Google credentials, Drive root and AI settings remain shared. Migration will retire `TELEGRAM_DIARY_USER_ID`, `GOOGLE_SHEET_ID` and `DIARY_START_DATE`; do not remove them manually from an existing installation.

Labels can change without changing identity or paths. Registry edits take effect when the bot restarts; scheduled jobs read them on their next run. Removing a user stops access and scheduled work for that diary but preserves its files. `users.json` is ignored by Git; keep any custom registry path private too.

## Storage

Each diary uses `data/users/<Telegram-ID>/`, with its own entries, days, aggregates, status, start date and archive bindings. `data/telegram.json` retains the shared Telegram cursor; `data/polling.json` records shared connection health. New diaries start on the date they are first enabled. Migration must preserve the existing diary's original start date.

Drive uses `<Health Diary root>/<Telegram-ID>/`, containing `entries`, `days`, `aggregates` and a separate **Diary Index** spreadsheet. Folders and indexes are created when needed; receiving a voice note never waits for Drive. Existing remote IDs are retained for retry and recovery. The planned `diary-users.txt` and per-folder `owner.txt` label files belong to checkpoint 3.

Scheduled jobs visit each configured diary and report failures per person. A failing diary does not prevent the remaining diaries from being checked. Exports remain on demand. An export or diary read requires an explicit owner; Telegram admin commands receive that owner from the menu. For offline inspection of a new-layout test installation, use `npm run day -- YYYY-MM-DD Telegram-ID`.

The two storage layouts are deliberately incompatible: the new mode refuses existing single-user records until migration, and the old mode refuses a directory already marked as multi-user. No migration is performed automatically by starting the bot.

## Using the admin menu in multi-user mode

Open **admin** from Telegram's command menu, or send `/admin`. Tap a person's label and ID, then use **Today**, **Latest day**, **Choose date**, **Export**, **Status** or **Retry**. Choose date opens a calendar with month navigation; typing `YYYY-MM-DD` there also works. Every result identifies the diary, including each part of a long reply.

**Switch person** returns to the list. **Close** (or `/cancel`) clears the admin selection; it does not delete records or disable voice recording. Voice notes always belong to the sender, even while viewing someone else's diary. Admins need an entry in `users.json` to record voice notes themselves.

The existing `/today`, `/yesterday`, `/last`, `/day`, `/status`, `/retry` and `/export` shortcuts work for the selected diary only. Without a selection they open the person picker. Old buttons expire after navigating to a new menu. Restarting the bot clears the selection too; open `/admin` again. Ordinary users have no access to these controls.

The menu uses [Telegram inline keyboards](https://core.telegram.org/bots/api#inlinekeyboardmarkup). Buttons are acknowledged when received and checked against the current admin, diary and menu before any action. Their removal from old messages is best effort; stale buttons remain invalid even if Telegram could not remove them.
