import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { localDate } from '../util/dates.js';
import { deletionSteps, makeSteps } from './metadata.js';

const finished = deletion => ['local_delete', 'drive_delete', 'sheet_delete']
  .every(key => deletion.steps[key].status === 'complete');

export async function lastEntryToday(ctx) {
  const date = localDate(ctx.now());
  const { entries, days, issues } = await ctx.store.scan();
  if (issues.some(issue => issue.date === date)
    || days.some(day => day.date === date && day.steps.daily_summary.status === 'complete')) {
    return { status: 'unavailable' };
  }
  const entry = entries.filter(entry => entry.date === date).at(-1);
  if (!entry) return { status: 'empty' };
  let preview = 'This entry is still being processed.';
  for (const name of ['summary.md', 'transcript.md']) {
    try { preview = (await readFile(join(ctx.store.entryPath(entry), name), 'utf8')).slice(0, 300); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { status: 'ready', entry_id: entry.entry_id, date, received_at: entry.received_at, preview };
}

// The caller holds the owner's writer lock. The durable record is the deletion
// intent and also prevents Telegram redelivery or normal retries recreating files.
export async function deleteLastEntryToday(ctx, { entryId, date }) {
  if (date !== localDate(ctx.now())) return { status: 'expired' };
  const { deletions } = await ctx.store.scan();
  const existing = deletions.find(item => item.entry_id === entryId);
  if (existing) return { status: finished(existing) ? 'complete' : 'pending' };
  const latest = await lastEntryToday(ctx);
  if (latest.status !== 'ready') return latest;
  if (latest.entry_id !== entryId) return { status: 'changed' };
  const { entries } = await ctx.store.scan();
  const entry = entries.find(item => item.entry_id === entryId);
  // Recheck after disk reads, immediately before persisting the intent.
  if (date !== localDate(ctx.now())) return { status: 'expired' };
  const deletion = {
    schema_version: 1, entry_id: entry.entry_id, date: entry.date,
    telegram_user_id: ctx.config.diaryUserId, telegram_message_id: entry.telegram_message_id,
    requested_at: ctx.now().toISOString(),
    ...(entry.drive_folder_id ? { drive_folder_id: entry.drive_folder_id } : {}),
    steps: makeSteps(deletionSteps),
  };
  await ctx.store.writeDeletion(deletion);
  await processDeletion(ctx, deletion, { force: true });
  return { status: finished(deletion) ? 'complete' : 'pending' };
}

export async function processDeletion(ctx, deletion, { force = false } = {}) {
  const { store, services, runner, config } = ctx;
  const save = store.writeDeletion;
  const run = (key, action, options = {}) => runner.run(deletion, key, save, action, { force, ...options });
  await run('local_delete', async () => {
    await rm(store.entryPath(deletion), { recursive: true, force: true });
    const { entries } = await store.scan();
    const day = await store.getDay(deletion.date);
    day.entry_count = entries.filter(entry => entry.date === deletion.date).length;
    await store.writeDay(day);
  });
  await run('drive_delete', async () => {
    const root = services.archive ? await services.archive.existingRootFolder() : config.googleDriveRootFolderId;
    await services.drive.deleteEntryFolder({ rootFolderId: root, date: deletion.date,
      entryId: deletion.entry_id, folderId: deletion.drive_folder_id });
  });
  await run('sheet_delete', () => services.sheets.deleteEntry(deletion.entry_id));
  if (finished(deletion)) {
    await run('telegram_deletion_notice', async () => {
      const result = await services.telegram.sendMessage(config.diaryUserId,
        `Deleted your entry from ${deletion.date} at ${deletion.entry_id.slice(11, 19).replaceAll('-', ':')} (Europe/London).\n\n`
        + 'Its recording, transcript and summary have been removed from this diary and Drive, and its Sheets entry has been removed. Existing exports and Telegram messages are unchanged.');
      return { telegram_message_id: result.message_id };
    }, { telegram: true });
  }
  await runner.alerts(deletion, save);
}

export async function retryDeletions(ctx, options = {}) {
  const { deletions } = await ctx.store.scan();
  for (const deletion of deletions) {
    if (deletionSteps.some(key => deletion.steps[key].status !== 'complete')) await processDeletion(ctx, deletion, options);
  }
}
