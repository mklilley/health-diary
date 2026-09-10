import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, atomicWriteJson, readJson } from '../util/atomic-write.js';
import { addDays, localDate, localTimestamp, validateDate, finalisationCutoff } from '../util/dates.js';
import { validAggregateMetadata } from './aggregates.js';

export async function statusIndex(ctx) {
  const { entries, days, issues } = await ctx.store.scan();
  const operations = [];
  const add = (id, key, step) => {
    if (step.status !== 'complete') operations.push({ id, operation: key, ...step });
    if (step.notification_error && (step.notification_delivery_uncertain || !step.alert_sent)) {
      operations.push({ id, operation: `${key}_admin_notification`, status: 'attention', attempts: 1,
        last_error: { code: 'ALERT_DELIVERY_UNCONFIRMED', message: 'Admin alert delivery unconfirmed' } });
    }
  };
  for (const entry of entries) for (const [key, step] of Object.entries(entry.steps)) add(entry.entry_id, key, step);
  for (const day of days) {
    if (day.date <= finalisationCutoff(ctx.now())) for (const [key, step] of Object.entries(day.steps)) add(day.date, key, step);
    if (day.reminder_sent && day.reminder?.status !== 'complete') add(day.date, 'reminder_delivery', { ...day.reminder, status: 'attention' });
    if (day.late_entry_ids?.length) operations.push({ id: day.date, operation: 'late_arrival_after_finalisation', status: 'attention', attempts: 0,
      last_error: { code: 'LATE_SOURCE', message: 'A voice note arrived after finalisation; stored daily summary remains unchanged' } });
  }
  for (const issue of issues) operations.push({ ...issue, status: 'attention', attempts: 0,
    last_error: { code: 'LOCAL_SOURCE_INVALID', message: 'Local source metadata or files need repair; existing files were preserved' } });
  let aggregates;
  try {
    aggregates = await readJson(join(ctx.store.root, 'aggregates', 'metadata.json'), { schema_version: 1, steps: {} });
    if (!validAggregateMetadata(aggregates)) throw new Error('Invalid aggregate state');
  }
  catch { aggregates = { steps: { metadata: { status: 'attention', attempts: 0, last_error: { message: 'Aggregate upload state is unreadable; rebuild required' } } } }; }
  for (const [key, step] of Object.entries(aggregates.steps)) add('aggregates', key, step);
  const state = await ctx.store.readState();
  const knownDates = new Set([...days.map(day => day.date), ...issues.filter(issue => issue.operation === 'invalid_day_metadata').map(issue => issue.date)]);
  for (let date = state.start_date; date <= finalisationCutoff(ctx.now()); date = addDays(date, 1)) {
    if (!knownDates.has(date)) operations.push({ id: date, operation: 'daily_summary', status: 'pending', attempts: 0,
      last_error: { code: 'DAILY_JOB_PENDING', message: 'This due day has not been finalised; run the daily or retry job' } });
  }
  if (state.steps?.telegram_poll) add('bot', 'telegram_poll', state.steps.telegram_poll);
  for (const [id, incident] of Object.entries(state.notifications || {})) {
    if (incident.delivery_uncertain || incident.notification_error) operations.push({ id, operation: 'admin_notification',
      status: 'attention', attempts: 1, last_error: { code: 'ALERT_DELIVERY_UNCONFIRMED', message: 'Admin notification delivery unconfirmed; inspect the private chat and data/state.json' } });
  }
  const today = entries.filter(entry => entry.date === localDate(ctx.now()));
  return { schema_version: 1, generated_at: localTimestamp(ctx.now()),
    entries_today: today.length,
    completed_today: today.filter(entry => Object.values(entry.steps).every(step => step.status === 'complete')).length,
    outstanding_retries: operations.filter(op => op.status !== 'attention').length,
    needs_attention: operations.filter(op => op.status === 'attention').length,
    last_completed_daily_summary: days.filter(day => day.steps.daily_summary.status === 'complete').at(-1)?.date || null,
    last_poll_drained_at: state.last_poll_drained_at,
    operations };
}

export async function rebuildStatus(ctx) {
  const index = await statusIndex(ctx);
  const lines = ['# Health Diary Status', '', `Generated: ${index.generated_at}`, '',
    `Entries today: ${index.entries_today}`, `Completed today: ${index.completed_today}`, '',
    `Outstanding retries: ${index.outstanding_retries}`, `Needs attention: ${index.needs_attention}`, '',
    `Last completed daily summary: ${index.last_completed_daily_summary || 'none'}`, '',
    `Last Telegram backlog drain: ${index.last_poll_drained_at || 'not yet recorded'}`, '',
    `Outstanding problems: ${index.operations.length ? index.operations.length : 'none'}`];
  for (const operation of index.operations) {
    lines.push('', `- ${operation.id} / ${operation.operation}: ${operation.status}; attempts ${operation.attempts}`);
    if (operation.last_error) lines.push(`  ${operation.last_error.code || ''}: ${operation.last_error.message}`);
    if (operation.next_retry_at) lines.push(`  Next retry: ${operation.next_retry_at}`);
  }
  const markdown = `${lines.join('\n')}\n`;
  await atomicWriteJson(join(ctx.store.root, 'status', 'index.json'), index);
  await atomicWrite(join(ctx.store.root, 'status', 'STATUS.md'), markdown);
  return markdown;
}

export async function showDay(ctx, date) {
  if (!validateDate(date)) throw new Error('Use a real ISO date: YYYY-MM-DD');
  const { entries, days, issues } = await ctx.store.scan();
  const day = days.find(day => day.date === date);
  const sources = entries.filter(entry => entry.date === date);
  if (day?.steps.daily_summary.status === 'complete') {
    return `${date}\nNumber of entries: ${day.summary_entry_count ?? day.entry_count}\n\n${await readFile(join(ctx.store.dayPath(day), 'summary.md'), 'utf8')}`;
  }
  const summaries = [];
  for (const entry of sources) {
    const text = entry.steps.entry_summary.status === 'complete'
      ? await readFile(join(ctx.store.entryPath(entry), 'summary.md'), 'utf8') : 'Processing pending.';
    summaries.push(`${entry.received_at}\n${text}`);
  }
  return `${date}\nNumber of entries so far: ${sources.length}\n\n${summaries.join('\n\n') || 'No entries recorded so far.'}${issues.some(issue => issue.date === date) ? '\n\nSome local source files need attention; this view may be incomplete.' : ''}`;
}

export async function lastDay(ctx) {
  const { days } = await ctx.store.scan();
  const day = days.filter(day => day.steps.daily_summary.status === 'complete').at(-1);
  return day ? showDay(ctx, day.date) : 'No completed daily summary yet.';
}
