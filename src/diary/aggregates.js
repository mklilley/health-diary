import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite, atomicWriteJson, readJson, exists } from '../util/atomic-write.js';
import { pendingStep } from './metadata.js';

export const aggregateNames = ['all-transcripts.md', 'all-entry-summaries.md', 'all-daily-summaries.md'];

export function validAggregateMetadata(value) {
  return value?.schema_version === 1 && value.steps && typeof value.steps === 'object'
    && !Array.isArray(value.steps) && Object.entries(value.steps).every(([name, step]) => aggregateNames.includes(name)
      && ['pending', 'running', 'retry', 'attention', 'complete'].includes(step?.status) && Number.isInteger(step.attempts));
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
  const contents = { 'all-transcripts.md': '# All transcripts\n', 'all-entry-summaries.md': '# All entry summaries\n', 'all-daily-summaries.md': '# All daily summaries\n' };
  for (const [target, source] of [['all-transcripts.md', 'transcript.md'], ['all-entry-summaries.md', 'summary.md']]) {
    let currentDate;
    for (const entry of entries) {
      const path = join(ctx.store.entryPath(entry), source);
      if (!await exists(path)) continue;
      if (currentDate !== entry.date) { contents[target] += `\n## ${entry.date}\n`; currentDate = entry.date; }
      contents[target] += `\n### ${entry.received_at}\nEntry: ${entry.entry_id}\n\n${await readFile(path, 'utf8')}\n`;
    }
  }
  for (const day of days) {
    const path = join(ctx.store.dayPath(day), 'summary.md');
    if (!await exists(path)) continue;
    contents['all-daily-summaries.md'] += `\n## ${day.date}\nNumber of entries: ${day.summary_entry_count ?? day.entry_count}\n\n${await readFile(path, 'utf8')}\n`;
  }
  for (const name of aggregateNames) {
    const hash = createHash('sha256').update(contents[name]).digest('hex');
    const step = metadata.steps[name] ||= pendingStep();
    if (step.source_hash !== hash) {
      if (step.status === 'complete') step.status = 'pending';
      step.source_hash = hash;
    }
    await atomicWrite(join(directory, name), contents[name]);
  }
  await save(metadata);
  if (upload) {
    for (const name of aggregateNames) {
      await ctx.runner.run(metadata, name, save, async step => {
        if (!metadata.drive_folder_id) {
          metadata.drive_folder_id = (await ctx.services.drive.ensureFolder(ctx.config.googleDriveRootFolderId, 'aggregates')).id;
          await save(metadata);
        }
        const result = await ctx.services.drive.putFile({ parentId: metadata.drive_folder_id, name, path: join(directory, name), mimeType: 'text/markdown', fileId: step.drive_file_id, mutable: true });
        return { drive_file_id: result.id, archived_hash: step.source_hash };
      }, { force });
    }
    await ctx.runner.alerts(metadata, save);
  }
  return { rebuilt: true, files: aggregateNames };
}
