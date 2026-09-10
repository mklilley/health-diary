import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite, exists } from '../util/atomic-write.js';
import { addDays, finalisationCutoff, localDate, localHour } from '../util/dates.js';
import { version as dailyPromptVersion } from '../prompts/daily-summary-v1.js';

async function folder(ctx, day) {
  if (day.drive_folder_id) return day.drive_folder_id;
  const base = await ctx.services.drive.ensureFolder(ctx.config.googleDriveRootFolderId, 'days');
  const target = await ctx.services.drive.ensureFolder(base.id, day.date);
  day.drive_folder_id = target.id;
  await ctx.store.writeDay(day);
  return target.id;
}

export async function processDay(ctx, day, { force = false } = {}) {
  const { store, runner, services } = ctx;
  const state = await store.readState();
  const { entries, issues } = await store.scan();
  const sources = entries.filter(entry => entry.date === day.date);
  const summaryStep = day.steps.daily_summary;
  const save = store.writeDay;
  const summaryPath = join(store.dayPath(day), 'summary.md');
  const summaryExists = await exists(summaryPath);
  if (summaryExists && summaryStep.status !== 'complete' && Array.isArray(day.source_entry_ids)) {
    const late = sources.filter(entry => !day.source_entry_ids.includes(entry.entry_id));
    if (late.length) day.late_entry_ids = [...new Set([...(day.late_entry_ids || []), ...late.map(entry => entry.entry_id)])];
  }
  if (summaryStep.status !== 'complete' && !summaryExists) {
    day.entry_count = sources.length;
    let reason;
    if (!state.last_poll_drained_at || localDate(state.last_poll_drained_at) <= day.date) reason = 'Waiting for Telegram backlog to be drained after this day ended';
    else if (issues.some(issue => issue.date === day.date)) reason = 'Waiting for repair of unreadable source metadata';
    else if (sources.some(entry => entry.steps.transcription.status !== 'complete')) reason = 'Waiting for all received voice notes to finish transcription';
    if (reason) {
      summaryStep.first_failure_at ||= ctx.now().toISOString();
      const aged = ctx.now().getTime() - Date.parse(summaryStep.first_failure_at) >= (ctx.config.attentionAfterMs ?? 3_600_000);
      summaryStep.status = aged || issues.some(issue => issue.date === day.date) ? 'attention' : 'retry';
      summaryStep.last_error = { type: 'dependency', code: 'WAITING_FOR_SOURCES', message: reason };
      summaryStep.next_retry_at = new Date(ctx.now().getTime() + (ctx.config.retryIntervalMs ?? 900_000)).toISOString();
      await save(day);
      await runner.alerts(day, save);
      return day;
    }
    if (summaryStep.last_error?.code === 'WAITING_FOR_SOURCES') summaryStep.next_retry_at = null;
  }
  const run = (key, action) => runner.run(day, key, save, action, { force });
  await run('daily_summary', async () => {
    // A successful file write followed by a crash must never trigger another AI call.
    if (!await exists(summaryPath)) {
      day.daily_summary_model = sources.length ? (day.daily_summary_model || ctx.config.dailySummaryModel) : null;
      day.daily_summary_prompt_version = sources.length ? (day.daily_summary_prompt_version || dailyPromptVersion) : null;
      day.source_entry_ids = sources.map(entry => entry.entry_id);
      day.summary_entry_count = sources.length;
      await save(day);
      const transcripts = await Promise.all(sources.map(async entry => ({
        entry_id: entry.entry_id, received_at: entry.received_at,
        transcript: await readFile(join(store.entryPath(entry), 'transcript.md'), 'utf8'),
      })));
      const summary = transcripts.length
        ? await services.openai.summarizeDay(transcripts, { model: day.daily_summary_model, date: day.date })
        : 'No entries recorded.';
      if (typeof summary !== 'string' || !summary.trim()) throw Object.assign(new Error('Empty summary'), { status: 422 });
      await atomicWrite(summaryPath, summary.trim());
    }
    return { model: day.daily_summary_model, prompt_version: day.daily_summary_prompt_version, generated_at: ctx.now().toISOString() };
  });
  if (summaryStep.status === 'complete') {
    await run('drive_summary', async step => {
      const result = await services.drive.putFile({ parentId: await folder(ctx, day), name: 'summary.md', path: summaryPath,
        mimeType: 'text/markdown', fileId: step.drive_file_id });
      return { drive_file_id: result.id };
    });
    await run('sheet_day', async () => {
      const result = await services.sheets.upsertDay({ date: day.date, summary: await readFile(summaryPath, 'utf8'), entryCount: day.summary_entry_count ?? day.entry_count });
      return { sheet_row: result?.row };
    });
    await runner.alerts(day, save);
    if (['drive_summary', 'sheet_day'].every(key => day.steps[key].status === 'complete')) {
      const source = structuredClone(day);
      delete source.steps.drive_metadata;
      const revision = createHash('sha256').update(JSON.stringify(source)).digest('hex');
      if (day.steps.drive_metadata.status === 'complete' && day.steps.drive_metadata.source_revision !== revision) day.steps.drive_metadata.status = 'pending';
      await run('drive_metadata', async step => {
        const snapshot = structuredClone(day);
        snapshot.steps.drive_metadata.status = 'complete';
        snapshot.steps.drive_metadata.completed_at = ctx.now().toISOString();
        const path = join(store.dayPath(day), '.archive-metadata.json');
        await atomicWrite(path, `${JSON.stringify(snapshot, null, 2)}\n`);
        const result = await services.drive.putFile({ parentId: await folder(ctx, day), name: 'metadata.json', path,
          mimeType: 'application/json', fileId: step.drive_file_id, mutable: true });
        await unlink(path);
        return { drive_file_id: result.id, source_revision: revision };
      });
    }
  }
  await runner.alerts(day, save);
  return day;
}

export async function finaliseDays(ctx, options = {}) {
  const state = await ctx.store.readState();
  const cutoff = finalisationCutoff(ctx.now());
  const { days, entries, issues } = await ctx.store.scan();
  const dates = [...new Set([state.start_date, ...days.map(d => d.date), ...entries.map(e => e.date)])].sort();
  const results = [];
  for (let date = dates[0]; date <= cutoff; date = addDays(date, 1)) {
    if (issues.some(issue => issue.date === date && issue.operation === 'invalid_day_metadata')) continue;
    const day = await ctx.store.getDay(date);
    results.push(await processDay(ctx, day, options));
  }
  return results;
}

export async function sendReminder(ctx) {
  const current = ctx.now();
  const date = localDate(current);
  if (localHour(current) < 22) return { sent: false, reason: 'outside_reminder_window' };
  const { entries, issues } = await ctx.store.scan();
  if (issues.some(issue => issue.date === date)) return { sent: false, reason: 'source_metadata_needs_attention' };
  if (entries.some(entry => entry.date === date)) return { sent: false, reason: 'voice_received' };
  const state = await ctx.store.readState();
  const pollAge = current.getTime() - Date.parse(state.last_poll_drained_at);
  if (!state.last_poll_drained_at || pollAge < 0 || pollAge > 300_000 || localDate(state.last_poll_drained_at) !== date) {
    return { sent: false, reason: 'waiting_for_recent_telegram_poll' };
  }
  const day = await ctx.store.getDay(date);
  if (day.reminder_sent) return { sent: false, reason: 'already_reserved' };
  // Reserve durably before the API call: never send a reminder twice for this date.
  day.reminder_sent = true;
  day.reminder = { status: 'running', attempts: 1, reserved_at: current.toISOString() };
  await ctx.store.writeDay(day);
  // A long lock wait or filesystem pause must not turn this into yesterday's reminder.
  if (localDate(ctx.now()) !== date) {
    day.reminder.status = 'complete';
    day.reminder.skipped_stale = true;
    await ctx.store.writeDay(day);
    return { sent: false, reason: 'stale' };
  }
  try {
    const result = await ctx.services.telegram.sendMessage(ctx.config.sisterUserId,
      "You haven't recorded anything today. When you have a moment, please send me a voice note about what you've eaten and how you've been feeling today.");
    day.reminder.status = 'complete';
    day.reminder.telegram_message_id = result.message_id;
    day.reminder.completed_at = ctx.now().toISOString();
  } catch {
    day.reminder.status = 'attention';
    day.reminder.last_error = { code: 'REMINDER_DELIVERY_UNCONFIRMED', message: 'Reminder delivery unconfirmed; reserved to prevent duplicate sends' };
  }
  await ctx.store.writeDay(day);
  return { sent: day.reminder.status === 'complete', date };
}
