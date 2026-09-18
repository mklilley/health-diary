import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite, atomicWriteJson, readJson, exists } from '../util/atomic-write.js';
import { pendingStep } from './metadata.js';
import { addDays, finalisationCutoff, localTimestamp } from '../util/dates.js';

export const aggregateNames = ['all-transcripts.md', 'all-entry-summaries.md', 'all-daily-summaries.md'];

export function validAggregateMetadata(value) {
  const validSteps = value?.schema_version === 1 && value.steps && typeof value.steps === 'object'
    && !Array.isArray(value.steps) && Object.entries(value.steps).every(([name, step]) => aggregateNames.includes(name)
      && ['pending', 'running', 'retry', 'attention', 'complete'].includes(step?.status) && Number.isInteger(step?.attempts));
  if (!validSteps) return false;
  if (value.upload_requested !== true) return true;
  const snapshot = value.snapshot;
  return Boolean(snapshot && Number.isFinite(Date.parse(snapshot.generated_at))
    && ['entry_count', 'transcript_count', 'entry_summary_count', 'daily_summary_count', 'entries_pending', 'due_daily_summaries_missing']
      .every(key => Number.isSafeInteger(snapshot[key]) && snapshot[key] >= 0)
    && aggregateNames.every(name => {
      const step = value.steps[name];
      return /^[a-f0-9]{64}$/.test(step?.source_hash) && (step.status !== 'complete'
        || (step.archived_hash === step.source_hash && typeof step.drive_file_id === 'string' && step.drive_file_id.length > 0));
    }));
}

export function exportResult(metadata) {
  const uploads = aggregateNames.map(name => {
    const step = metadata.steps[name];
    const complete = step?.status === 'complete' && step.archived_hash === step.source_hash;
    return { name, complete, url: complete && step.drive_file_id
      ? `https://drive.google.com/file/d/${encodeURIComponent(step.drive_file_id)}/view` : null };
  });
  return { rebuilt: true, snapshot: metadata.snapshot, files: aggregateNames, uploads,
    uploaded: uploads.every(file => file.complete) };
}

/** Retry only a requested, persisted snapshot. Never read the diary sources here. */
export async function retryAggregateUploads(ctx, { force = false } = {}) {
  const directory = join(ctx.store.root, 'aggregates');
  const metadataPath = join(directory, 'metadata.json');
  let metadata;
  try { metadata = await readJson(metadataPath, null); } catch { return null; }
  if (!validAggregateMetadata(metadata) || metadata.upload_requested !== true || !metadata.snapshot) return null;
  if (aggregateNames.every(name => metadata.steps[name]?.status === 'complete')) return exportResult(metadata);
  const save = meta => atomicWriteJson(metadataPath, meta);
  for (const name of aggregateNames) {
    await ctx.runner.run(metadata, name, save, async step => {
      const path = join(directory, name);
      const hash = createHash('sha256').update(await readFile(path)).digest('hex');
      if (hash !== step.source_hash) {
        throw Object.assign(new Error('Saved export changed; request a fresh export'), { code: 'EXPORT_SNAPSHOT_CHANGED' });
      }
      if (!metadata.drive_folder_id) {
        metadata.drive_folder_id = (await ctx.services.drive.ensureFolder(ctx.config.googleDriveRootFolderId, 'aggregates')).id;
        await save(metadata);
      }
      const result = await ctx.services.drive.putFile({ parentId: metadata.drive_folder_id, name, path,
        mimeType: 'text/markdown', fileId: step.drive_file_id, mutable: true });
      return { drive_file_id: result.id, archived_hash: step.source_hash };
    }, { force });
  }
  await ctx.runner.alerts(metadata, save);
  return exportResult(metadata);
}

export async function rebuildAggregates(ctx, { upload = false, force = false } = {}) {
  const { entries, days, issues } = await ctx.store.scan();
  // Never replace a good archive with a silently incomplete corpus after corruption.
  if (issues.length) return { rebuilt: false, reason: 'source_metadata_needs_attention' };
  const directory = join(ctx.store.root, 'aggregates');
  const metadataPath = join(directory, 'metadata.json');
  let metadata;
  try { metadata = await readJson(metadataPath, null); } catch { /* Derived state is rebuildable. */ }
  if (!validAggregateMetadata(metadata)) metadata = { schema_version: 1, steps: {}, attention: {} };
  const save = meta => atomicWriteJson(metadataPath, meta);
  const snapshot = {
    generated_at: localTimestamp(ctx.now()), entry_count: entries.length,
    transcript_count: 0, entry_summary_count: 0, daily_summary_count: 0,
    entries_pending: entries.filter(entry => Object.values(entry.steps).some(step => step.status !== 'complete')).length,
    due_daily_summaries_missing: 0,
  };
  const contents = Object.fromEntries(aggregateNames.map(name => [name, '']));
  for (const [target, source] of [['all-transcripts.md', 'transcript.md'], ['all-entry-summaries.md', 'summary.md']]) {
    let currentDate;
    for (const entry of entries) {
      const path = join(ctx.store.entryPath(entry), source);
      if (!await exists(path)) continue;
      snapshot[source === 'transcript.md' ? 'transcript_count' : 'entry_summary_count']++;
      if (currentDate !== entry.date) { contents[target] += `\n## ${entry.date}\n`; currentDate = entry.date; }
      contents[target] += `\n### ${entry.received_at}\nEntry: ${entry.entry_id}\n\n${await readFile(path, 'utf8')}\n`;
    }
  }
  const includedDays = new Set();
  for (const day of days) {
    const path = join(ctx.store.dayPath(day), 'summary.md');
    if (!await exists(path)) continue;
    snapshot.daily_summary_count++;
    includedDays.add(day.date);
    contents['all-daily-summaries.md'] += `\n## ${day.date}\nNumber of entries: ${day.summary_entry_count ?? day.entry_count}\n\n${await readFile(path, 'utf8')}\n`;
  }
  const state = await ctx.store.readState();
  const cutoff = finalisationCutoff(ctx.now());
  for (let date = state.start_date; date <= cutoff; date = addDays(date, 1)) {
    if (!includedDays.has(date)) snapshot.due_daily_summaries_missing++;
  }
  const details = [
    `Generated: ${snapshot.generated_at} (Europe/London)`,
    `Diary entries recorded: ${snapshot.entry_count}`,
    `Transcripts included: ${snapshot.transcript_count}/${snapshot.entry_count}`,
    `Entry summaries included: ${snapshot.entry_summary_count}/${snapshot.entry_count}`,
    `Daily summaries included: ${snapshot.daily_summary_count}`,
    `Entries still processing: ${snapshot.entries_pending}`,
    `Due daily summaries missing: ${snapshot.due_daily_summaries_missing}`,
    'Snapshot of saved text; later changes require a new export.',
  ].join('\n');
  const titles = ['All transcripts', 'All entry summaries', 'All daily summaries'];
  // Disarm old upload retries before replacing any local files. If preparation
  // is interrupted, no mixed set of old and new files can be uploaded by cron.
  metadata.upload_requested = false;
  await save(metadata);
  for (const [index, name] of aggregateNames.entries()) {
    contents[name] = `# ${titles[index]}\n\n${details}\n${contents[name]}`;
    const hash = createHash('sha256').update(contents[name]).digest('hex');
    const previous = metadata.steps[name];
    metadata.steps[name] = { ...pendingStep(), source_hash: hash,
      ...(previous?.drive_file_id ? { drive_file_id: previous.drive_file_id } : {}) };
    await atomicWrite(join(directory, name), contents[name]);
  }
  metadata.snapshot = snapshot;
  metadata.upload_requested = upload;
  await save(metadata);
  return upload ? retryAggregateUploads(ctx, { force }) : exportResult(metadata);
}
