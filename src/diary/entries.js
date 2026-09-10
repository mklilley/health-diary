import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWrite, exists } from '../util/atomic-write.js';
import { entryIdentity } from '../util/dates.js';
import { makeSteps, entrySteps } from './metadata.js';
import { version as entryPromptVersion } from '../prompts/entry-summary-v1.js';
import { version as transcriptionPromptVersion, transcriptionOptions } from '../prompts/transcription-v1.js';

export async function receiveVoice(ctx, message) {
  const { config, store } = ctx;
  if (message?.from?.id !== config.sisterUserId || message.chat?.type !== 'private' || message.chat.id !== config.sisterUserId
    || !Number.isSafeInteger(message.message_id) || message.message_id <= 0 || !Number.isSafeInteger(message.date)
    || !message.voice?.file_id || typeof message.voice.file_id !== 'string') throw new Error('Invalid diary voice message');
  const { entries, issues } = await store.scan();
  const old = entries.find(entry => entry.telegram_user_id === message.from.id && entry.telegram_message_id === message.message_id);
  if (old) return old;
  const { entryId, receivedAt, date } = entryIdentity(message);
  if (issues.some(issue => issue.id === entryId)) throw new Error('Entry metadata needs repair before redelivery');
  const metadata = {
    schema_version: 1, entry_id: entryId, date,
    telegram_user_id: message.from.id, telegram_chat_id: message.chat.id,
    telegram_message_id: message.message_id, telegram_file_id: message.voice.file_id,
    received_at: receivedAt, ingested_at: ctx.now().toISOString(),
    transcription_model: config.transcriptionModel, transcription_prompt_version: transcriptionPromptVersion,
    transcription_configuration: { ...transcriptionOptions, original_format: 'ogg/opus', language: 'auto', prompt: null },
    entry_summary_model: config.entrySummaryModel, entry_summary_prompt_version: entryPromptVersion,
    steps: makeSteps(entrySteps),
    attention: { required: false, alert_sent: false, resolved_alert_sent: false },
  };
  // The receipt is durable before polling advances its cursor or an API is called.
  await store.writeEntry(metadata);
  const state = await store.readState();
  if (date < state.start_date) { state.start_date = date; await store.writeState(state); }
  const day = await store.getDay(date);
  day.entry_count = entries.filter(e => e.date === date).length + 1;
  if (day.steps.daily_summary.status === 'complete') {
    day.late_entry_ids ||= [];
    day.late_entry_ids.push(entryId);
    // Preserve the completed source set and summary; make the exceptional late arrival visible.
  }
  await store.writeDay(day);
  return metadata;
}

async function folder(ctx, entry) {
  if (entry.drive_folder_id) return entry.drive_folder_id;
  const base = await ctx.services.drive.ensureFolder(ctx.config.googleDriveRootFolderId, 'entries');
  const date = await ctx.services.drive.ensureFolder(base.id, entry.date);
  const target = await ctx.services.drive.ensureFolder(date.id, entry.entry_id);
  entry.drive_folder_id = target.id;
  await ctx.store.writeEntry(entry);
  return target.id;
}

export async function processEntry(ctx, entry, { force = false } = {}) {
  const { store, services, runner } = ctx;
  const directory = store.entryPath(entry);
  const save = store.writeEntry;
  const run = (key, action, options = {}) => runner.run(entry, key, save, action, { force, ...options });
  const audioPath = join(directory, 'audio.ogg');
  const transcriptPath = join(directory, 'transcript.md');
  const summaryPath = join(directory, 'summary.md');
  const done = key => entry.steps[key].status === 'complete';
  await run('telegram_audio_download', async () => {
    if (!await exists(audioPath)) await atomicWrite(audioPath, await services.telegram.downloadVoice(entry.telegram_file_id));
  });
  if (done('telegram_audio_download')) {
    await run('transcription', async () => {
      if (!await exists(transcriptPath)) {
        const transcript = await services.openai.transcribe(audioPath, { model: entry.transcription_model });
        if (typeof transcript !== 'string' || !transcript.trim()) throw Object.assign(new Error('Empty transcription'), { status: 422 });
        await atomicWrite(transcriptPath, transcript);
      }
    });
  }
  if (done('transcription')) {
    const pendingNotice = entry.steps.telegram_pending_notice;
    if (pendingNotice && pendingNotice.status !== 'complete') {
      // An undelivered "could not transcribe" notice is obsolete after recovery.
      // Completing this bookkeeping step does not claim the notice was delivered.
      Object.assign(pendingNotice, { status: 'complete', superseded: true, completed_at: ctx.now().toISOString(), next_retry_at: null, last_error: null });
      delete pendingNotice.ambiguous_delivery;
      await save(entry);
    }
    await run('entry_summary', async () => {
      if (!await exists(summaryPath)) {
        const summary = await services.openai.summarizeEntry(await readFile(transcriptPath, 'utf8'), { model: entry.entry_summary_model });
        if (typeof summary !== 'string' || !summary.trim()) throw Object.assign(new Error('Empty summary'), { status: 422 });
        await atomicWrite(summaryPath, summary.trim());
      }
    });
  }
  if (done('entry_summary')) {
    await run('telegram_acknowledgement', async () => {
      const result = await services.telegram.sendMessage(entry.telegram_chat_id, `Recorded ✓\n\n${await readFile(summaryPath, 'utf8')}`);
      return { telegram_message_id: result.message_id };
    }, { telegram: true });
  } else if (done('telegram_audio_download') && !done('transcription')) {
    await run('telegram_pending_notice', async () => {
      const result = await services.telegram.sendMessage(entry.telegram_chat_id, "I received your voice note but couldn't transcribe it yet. I've kept it and will try again.");
      return { telegram_message_id: result.message_id };
    }, { telegram: true });
  }
  for (const [key, source, name, mimeType] of [
    ['drive_audio', 'telegram_audio_download', 'audio.ogg', 'audio/ogg'],
    ['drive_transcript', 'transcription', 'transcript.md', 'text/markdown'],
    ['drive_summary', 'entry_summary', 'summary.md', 'text/markdown'],
  ]) {
    if (done(source)) await run(key, async step => {
      const result = await services.drive.putFile({ parentId: await folder(ctx, entry), name, path: join(directory, name), mimeType, fileId: step.drive_file_id });
      return { drive_file_id: result.id, web_view_link: result.webViewLink || `https://drive.google.com/file/d/${result.id}/view` };
    });
  }
  if (done('entry_summary') && done('drive_audio') && done('drive_transcript')) {
    await run('sheet_entry', async () => {
      const result = await services.sheets.upsertEntry({ entryId: entry.entry_id, receivedAt: entry.received_at,
        summary: await readFile(summaryPath, 'utf8'), audioLink: entry.steps.drive_audio.web_view_link,
        transcriptLink: entry.steps.drive_transcript.web_view_link });
      return { sheet_row: result?.row };
    });
  }
  await runner.alerts(entry, save);
  if (ctx.config.retainLocalAudio === false && done('transcription') && done('drive_audio')) {
    // A crash between unlink and the following write is safe and recognisable.
    entry.local_audio_removal_authorized = true;
    await save(entry);
    await unlink(audioPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    entry.local_audio_removed = true;
    await save(entry);
  }
  // Metadata is a snapshot. Its own upload is marked complete in the remote snapshot,
  // because the existence of that snapshot proves the upload reached Drive.
  if (['drive_audio', 'drive_transcript', 'drive_summary', 'sheet_entry'].every(done)) {
    const revisionSource = structuredClone(entry);
    delete revisionSource.steps.drive_metadata;
    const revision = createHash('sha256').update(JSON.stringify(revisionSource)).digest('hex');
    if (done('drive_metadata') && entry.steps.drive_metadata.source_revision !== revision) {
      entry.steps.drive_metadata.status = 'pending';
    }
    await run('drive_metadata', async step => {
      const snapshot = structuredClone(entry);
      snapshot.steps.drive_metadata.status = 'complete';
      snapshot.steps.drive_metadata.completed_at = ctx.now().toISOString();
      const snapshotPath = join(directory, '.archive-metadata.json');
      await atomicWrite(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
      const result = await services.drive.putFile({ parentId: await folder(ctx, entry), name: 'metadata.json', path: snapshotPath,
        mimeType: 'application/json', fileId: step.drive_file_id, mutable: true });
      await unlink(snapshotPath);
      return { drive_file_id: result.id, source_revision: revision };
    });
  }
  await runner.alerts(entry, save);
  return entry;
}
