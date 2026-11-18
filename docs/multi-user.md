# Multiple diaries

One installation serves multiple separate diaries using one Telegram bot and one Google archive account. Follow the [setup guide](setup.md) to get started.

## Configuration

The private `users.json` file lists allowed diary users. Copyable examples are in `users.example.json`:

```json
[
  { "telegramUserId": 123456789, "label": "Alex" },
  { "telegramUserId": 987654321, "label": "Sam" }
]
```

`.env` uses `DIARY_USERS_FILE=users.json` and `TELEGRAM_ADMIN_USER_ID`. The admin may also appear in `users.json`. The bot token, Google credentials, Drive root and AI settings remain shared.

Labels can change without changing identity or paths. Registry edits take effect when the bot restarts; scheduled jobs read them on their next run. Removing a user stops access and scheduled work for that diary but preserves its files. `users.json` is ignored by Git; keep any custom registry path private too.

### Optional vocabulary corrections

Select vocabulary profiles using `transcriptionCorrections` in each person's record in the **server's** `users.json`, then restart the bot. For someone who means **Quorn** whenever they say standalone “corn”, enable the `corn-quorn-v1` profile:

```json
{ "telegramUserId": 987654321, "label": "Sam", "transcriptionCorrections": ["corn-quorn-v1"] }
```

Omit the setting or use `[]` to use the general transcription prompt without vocabulary-specific hints or automatic text corrections. Profiles apply only to that person's newly received recordings. The `corn-quorn-v1` profile resolves “corn with a Q” and “Quorn with a Q” to **Quorn**, then changes other standalone “corn” to **Quorn**, except within these allowed phrases: **corn cakes**, **pop corn**, **corn flakes**, **sweetcorn**, **sweet corn**, and **corn on the cob**. Matching ignores case and accepts spaces or hyphens between words. An explicit **“with a C”** overrides the personal default and becomes **corn**. Whole words inside longer words, such as `popcorn`, are not replaced.

Profile definitions, protected phrases and correction logic are in [vocabulary.js](../src/transcription/vocabulary.js). Additional word or phrase rules can be added there as named profiles and selected through the same setting. Unknown or duplicate profile names are rejected. Profiles run in the listed order, once, before the transcript is saved and before summaries or uploads. The recording stays unchanged. Each entry saves its prompt and profile IDs so pending work uses the same rules after a restart, even if the setting changes. Keep published profile versions stable when adding new ones. Enabling a profile does not rewrite existing records automatically; use **Fix transcripts** below to repair them explicitly. Pulling code updates does not update the private server registry.

## Storage

Each diary uses `data/users/<Telegram-ID>/`, with its own entries, days, aggregates, status, start date and archive bindings. `data/telegram.json` retains the shared Telegram cursor; `data/polling.json` records shared connection health. New diaries start on the date they are first enabled.

Drive uses `<Health Diary root>/<Telegram-ID>/`, containing `entries`, `days`, `aggregates` and a separate **Diary Index** spreadsheet. Folders and indexes are created when needed; receiving a voice note never waits for Drive. Existing remote IDs are retained for retry and recovery.

The root's `diary-users.txt` maps names to IDs; each person's folder has `owner.txt`. These are generated from `users.json`. After changing a label, restart the bot; the next scheduled retry pass updates the generated files. Use `npm run sync-users` to synchronize immediately. Unchanged labels are not uploaded again. Failed updates are retried, and never rebuild health aggregates. Removed users' archives remain in place with their last recorded owner labels.

Scheduled jobs visit each configured diary and report failures per person. A failing diary does not prevent the remaining diaries from being checked. Exports remain on demand. An export or diary read requires an explicit owner; Telegram admin commands receive that owner from the menu. For offline inspection, use `npm run day -- YYYY-MM-DD Telegram-ID`.

## Using the admin menu in multi-user mode

Open **admin** from Telegram's command menu, or send `/admin`. Tap a person's label and ID, then use **Today**, **Latest day**, **Choose date**, **Export**, **Status**, **Retry pending** or **Fix transcripts**. Choose date opens a calendar with month navigation; typing `YYYY-MM-DD` there also works. Every result identifies the diary, including each part of a long reply.

**Retry pending** tries unfinished processing, uploads and deletion cleanup for the selected diary immediately. Completed steps are skipped. Scheduled jobs also retry automatically.

**Switch person** returns to the list. **Close** clears the admin selection; it does not delete records or disable voice recording. `/cancel` cancels an open deletion confirmation, or otherwise closes the admin controls. Voice notes always belong to the sender, even while viewing someone else's diary. Admins need an entry in `users.json` to record voice notes themselves.

The `/today`, `/yesterday`, `/last`, `/day`, `/status`, `/retry`, `/export` and `/repair` shortcuts work for the selected diary only. `/repair` opens a preview; it never applies changes immediately. Without a selection they open the person picker. Old buttons expire after navigating to a new menu. Restarting the bot clears the selection too; open `/admin` again. Ordinary users have no access to these controls.

The menu uses [Telegram inline keyboards](https://core.telegram.org/bots/api#inlinekeyboardmarkup). Buttons are acknowledged when received and checked against the current admin, diary and menu before any action. Their removal from old messages is best effort; stale buttons remain invalid even if Telegram could not remove them.

## Repairing existing transcripts

Enable the intended vocabulary profile for that person in the server's `users.json` and restart the bot. Open `/admin`, select the person, then **Fix transcripts**. Review the matching entries and tap **Apply corrections**. No PM2 or cron pause is needed.

The scan checks saved transcripts against that person's enabled profiles. It shows the number of matching entries, affected saved daily summaries, and an example change for each of the first eight matches. Entries already processed with a profile are skipped: applying it twice could reinterpret a previously preserved “corn with a C”, which is saved as just “corn”. This is a vocabulary repair, not a general spelling checker or a new audio transcription.

Confirmation corrects the matching local transcripts, regenerates their entry summaries and any saved daily summaries for those dates, then updates Drive and Sheets using the existing file IDs and rows. Daily summaries use all current transcripts for each affected date, including any late entries. Days without a saved summary keep their normal schedule. Existing aggregate exports are refreshed after the repaired records finish syncing; diaries with no export do not get one automatically. Original audio and previously sent Telegram messages stay unchanged. Other users' diaries are not scanned or changed.

Original transcripts, summaries and metadata are backed up privately under `data/users/<ID>/repairs/<repair-ID>/`. Repair progress survives a restart. **Retry pending** or scheduled retries continue unfinished work, and **Status** reports outstanding operations. While a repair is pending, a new export and deletion of an affected entry wait until it finishes. New voice notes can still be received. If source records change between preview and confirmation, open a fresh preview before applying.

This action finds entries whose **transcripts** need correction. It does not independently search summaries, import edits made on Drive, or fix unrelated recognition errors. A correctly spelled transcript with an independently incorrect summary will not be selected.

## Undoing today's latest entry

Every approved diary user has **Delete last entry today** in Telegram's command menu (or `/delete_last`). It previews the sender's latest entry from the current Europe/London date and offers **Delete** and **Cancel**. If there are no entries today, it says so. Admin selection never changes whose entry is deleted: this always applies to the sender's own diary.

Confirmation permanently removes the entry's local folder, its Drive folder (audio, transcript, summary and metadata), and its Sheets row. It also works for an entry that has not finished processing. The confirmation expires if a newer entry arrives, the London date changes, or the bot restarts. Previous days and completed daily summaries are not changed.

If cleanup cannot finish, the bot reports it as queued and retries automatically. It sends a completion message once the files and row have been removed. Existing aggregate exports, Telegram messages and independent backups remain unchanged. An administrator can select **Export** again to replace the combined files with a snapshot that excludes the deleted entry. No PM2 or cron pause is needed to use this feature.
