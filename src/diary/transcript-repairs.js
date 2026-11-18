import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWrite, atomicWriteJson, exists, readJson } from '../util/atomic-write.js';
import { applyTranscriptionCorrections, getVocabularyProfiles } from '../transcription/vocabulary.js';
import { makeSteps, pendingStep } from './metadata.js';
import { processEntry } from './entries.js';
import { processDay } from './days.js';
import { rebuildAggregates, retryAggregateUploads } from './aggregates.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const pathFor = ctx => join(ctx.store.root, 'repairs', 'current.json');
const saveFor = ctx => job => atomicWriteJson(pathFor(ctx), job);
const complete = job => Object.values(job.steps).every(step => step.status === 'complete');
const waiting = () => Object.assign(new Error('Transcript repair has unfinished work; retry pending operations'), { code: 'REPAIR_PENDING' });

export async function readTranscriptRepair(ctx) {
  const job = await readJson(pathFor(ctx), null);
  if (!job) return null;
  if (job.schema_version !== 1 || job.telegram_user_id !== ctx.config.diaryUserId
    || !/^[a-f0-9-]{36}$/.test(job.id) || !Array.isArray(job.entries) || !Array.isArray(job.days)
    || !['prepare', 'entries', 'days', 'exports'].every(key => Number.isInteger(job.steps?.[key]?.attempts))
    || job.entries.some(item => !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_\d+$/.test(item.metadata?.entry_id)
      || item.metadata.date !== item.metadata.entry_id.slice(0, 10) || item.metadata.telegram_user_id !== ctx.config.diaryUserId
      || typeof item.corrected !== 'string')
    || job.days.some(day => !/^\d{4}-\d{2}-\d{2}$/.test(day.date))) {
    throw new Error('Invalid transcript repair record');
  }
  return job.completed_at ? null : job;
}

async function planRepair(ctx) {
  const active = await readTranscriptRepair(ctx);
  if (active) return { status: 'pending', entry_count: active.entries.length, day_count: active.days.length };
  const profiles = getVocabularyProfiles(ctx.config.transcriptionCorrections).map(profile => profile.id);
  if (!profiles.length) return { status: 'disabled' };
  const { entries, days, issues } = await ctx.store.scan();
  if (issues.length) return { status: 'unavailable' };
  const targets = [];
  for (const entry of entries) {
    if (entry.steps.transcription.status !== 'complete') continue;
    // In particular, never reinterpret a saved, explicitly clarified "corn".
    const applied = new Set([...(entry.transcription_configuration?.correction_profiles || []),
      ...(entry.transcript_repairs || []).flatMap(repair => repair.profiles)]);
    const missing = profiles.filter(id => !applied.has(id));
    if (!missing.length) continue;
    const original = await readFile(join(ctx.store.entryPath(entry), 'transcript.md'), 'utf8');
    const corrected = applyTranscriptionCorrections(original, missing);
    if (corrected !== original) targets.push({ metadata: entry, profiles: missing, original, corrected });
  }
  const dates = new Set(targets.map(item => item.metadata.date));
  // Only invalidate summaries that have already been generated. Other days
  // continue through their normal end-of-day schedule with corrected sources.
  const affectedDays = [];
  for (const day of days) if (dates.has(day.date) && await exists(join(ctx.store.dayPath(day), 'summary.md'))) affectedDays.push(day);
  const aggregates = await readJson(join(ctx.store.root, 'aggregates', 'metadata.json'), null);
  const refreshExports = Boolean(aggregates?.snapshot);
  const uploadExports = refreshExports && (aggregates.upload_requested === true
    || Object.values(aggregates.steps || {}).some(step => step.drive_file_id));
  const fingerprint = hash(JSON.stringify({ owner: ctx.config.diaryUserId, profiles, targets, affectedDays, aggregates }));
  return { status: targets.length ? 'ready' : 'empty', fingerprint, targets, affectedDays, refreshExports, uploadExports };
}

export async function previewTranscriptRepair(ctx) {
  const plan = await planRepair(ctx);
  if (plan.status !== 'ready') return { status: plan.status, entry_count: plan.entry_count, day_count: plan.day_count };
  return { status: 'ready', fingerprint: plan.fingerprint, day_count: plan.affectedDays.length,
    refresh_exports: plan.refreshExports, entries: plan.targets.map(item => ({
      entry_id: item.metadata.entry_id, received_at: item.metadata.received_at,
      before: item.original, after: item.corrected,
    })) };
}

function reset(metadata, keys, jobId) {
  for (const key of keys) {
    const old = metadata.steps[key];
    metadata.steps[key] = { ...pendingStep(),
      ...(old.drive_file_id ? { drive_file_id: old.drive_file_id } : {}),
      ...(['drive_transcript', 'drive_summary'].includes(key) ? { replacement_authorized: jobId } : {}),
    };
  }
}

// Run before any diary mutation. A crash halfway through local preparation is
// replayed from the durable plan before normal processing can see mixed files.
export async function prepareTranscriptRepair(ctx) {
  const job = await readTranscriptRepair(ctx);
  if (!job || job.steps.prepare.status === 'complete') return;
  const prepared = await ctx.runner.run(job, 'prepare', saveFor(ctx), async () => {
    for (const item of job.entries) {
      const entry = structuredClone(item.metadata);
      const directory = ctx.store.entryPath(entry);
      reset(entry, ['entry_summary', 'drive_transcript', 'drive_summary', 'sheet_entry', 'drive_metadata'], job.id);
      entry.transcript_repairs = [...(entry.transcript_repairs || []), { id: job.id, profiles: item.profiles,
        corrected_at: job.created_at, before_hash: hash(item.original), after_hash: hash(item.corrected) }];
      await atomicWrite(join(directory, 'transcript.md'), item.corrected);
      await unlink(join(directory, 'summary.md')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await ctx.store.writeEntry(entry);
    }
    for (const original of job.days) {
      const day = structuredClone(original);
      reset(day, ['daily_summary', 'drive_summary', 'sheet_day', 'drive_metadata'], job.id);
      delete day.late_entry_ids;
      await unlink(join(ctx.store.dayPath(day), 'summary.md')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await ctx.store.writeDay(day);
    }
  }, { force: true });
  if (!prepared) throw waiting();
}

export async function startTranscriptRepair(ctx, fingerprint) {
  const plan = await planRepair(ctx);
  if (plan.status !== 'ready') return { status: plan.status };
  if (fingerprint !== plan.fingerprint) return { status: 'changed' };
  const job = { schema_version: 1, kind: 'transcript_repair', id: randomUUID(), telegram_user_id: ctx.config.diaryUserId,
    created_at: ctx.now().toISOString(), entries: plan.targets, days: plan.affectedDays,
    refresh_exports: plan.refreshExports, upload_exports: plan.uploadExports,
    steps: makeSteps(['prepare', 'entries', 'days', 'exports']) };
  const backup = join(ctx.store.root, 'repairs', job.id);
  // Back up every affected source before arming the job or changing any file.
  for (const [kind, records, getPath] of [
    ['entries', job.entries.map(item => item.metadata), ctx.store.entryPath],
    ['days', job.days, ctx.store.dayPath],
  ]) for (const record of records) {
    const target = join(backup, kind, record.entry_id || record.date);
    await atomicWriteJson(join(target, 'metadata.json'), record);
    for (const name of kind === 'entries' ? ['transcript.md', 'summary.md'] : ['summary.md']) {
      const source = join(getPath(record), name);
      if (await exists(source)) await atomicWrite(join(target, name), await readFile(source));
    }
  }
  await atomicWriteJson(join(backup, 'repair.json'), job);
  await saveFor(ctx)(job);
  return resumeTranscriptRepair(ctx, { force: true });
}

export async function resumeTranscriptRepair(ctx, { force = false } = {}) {
  await prepareTranscriptRepair(ctx);
  const job = await readTranscriptRepair(ctx);
  if (!job) return null;
  const save = saveFor(ctx);
  const run = (key, action) => ctx.runner.run(job, key, save, action, { force });
  await run('entries', async () => {
    const { entries, issues } = await ctx.store.scan();
    if (issues.length) throw waiting();
    for (const item of job.entries) {
      const entry = entries.find(entry => entry.entry_id === item.metadata.entry_id);
      if (!entry) throw waiting();
      await processEntry(ctx, entry, { force });
      if (['entry_summary', 'drive_transcript', 'drive_summary', 'sheet_entry', 'drive_metadata']
        .some(key => entry.steps[key].status !== 'complete')) throw waiting();
    }
  });
  if (job.steps.entries.status === 'complete') await run('days', async () => {
    for (const original of job.days) {
      const day = await ctx.store.getDay(original.date);
      await processDay(ctx, day, { force });
      if (Object.values(day.steps).some(step => step.status !== 'complete')) throw waiting();
    }
  });
  if (job.steps.days.status === 'complete') await run('exports', async () => {
    if (!job.refresh_exports) return;
    if (!job.exports_prepared) {
      const result = await rebuildAggregates(ctx, { upload: job.upload_exports, force });
      if (!result.rebuilt) throw waiting();
      job.exports_prepared = true;
      await save(job);
    }
    if (job.upload_exports && !(await retryAggregateUploads(ctx, { force }))?.uploaded) throw waiting();
  });
  if (complete(job)) {
    job.completed_at = ctx.now().toISOString();
    await atomicWriteJson(join(ctx.store.root, 'repairs', job.id, 'repair.json'), job);
    await save(job);
  }
  return { status: job.completed_at ? 'complete' : 'pending', entry_count: job.entries.length,
    day_count: job.days.length, refreshed_exports: job.refresh_exports, backup_directory: join(ctx.store.root, 'repairs', job.id) };
}
