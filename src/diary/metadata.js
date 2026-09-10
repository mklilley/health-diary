import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteJson, readJson, exists } from '../util/atomic-write.js';
import { validateDate, localDate } from '../util/dates.js';

export const entrySteps = ['telegram_audio_download', 'transcription', 'entry_summary', 'drive_audio', 'drive_transcript', 'drive_summary', 'sheet_entry', 'telegram_acknowledgement', 'drive_metadata'];
export const daySteps = ['daily_summary', 'drive_summary', 'sheet_day', 'drive_metadata'];
export const pendingStep = () => ({ status: 'pending', attempts: 0 });
export const makeSteps = keys => Object.fromEntries(keys.map(key => [key, pendingStep()]));
const states = new Set(['pending', 'running', 'retry', 'attention', 'complete']);
const entryPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_\d+$/;

export function makeDay(date) {
  return { schema_version: 1, date, entry_count: 0, reminder_sent: false,
    reminder: pendingStep(), steps: makeSteps(daySteps),
    attention: { required: false, alert_sent: false, resolved_alert_sent: false } };
}

function validSteps(metadata, keys) {
  return keys.every(key => states.has(metadata.steps?.[key]?.status) && Number.isInteger(metadata.steps[key].attempts));
}

export function createStore(config, now) {
  const root = config.dataDir;
  const entryPath = entry => join(root, 'entries', entry.date, entry.entry_id);
  const dayPath = day => join(root, 'days', typeof day === 'string' ? day : day.date);
  async function directories(path) {
    try { return (await readdir(path, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name).sort(); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function scan() {
    const entries = [], days = [], issues = [];
    for (const date of (await directories(join(root, 'entries'))).filter(validateDate)) {
      for (const id of await directories(join(root, 'entries', date))) {
        if (!entryPattern.test(id)) { issues.push({ date, id: date, operation: 'unrecognised_entry_directory' }); continue; }
        try {
          const entry = await readJson(join(root, 'entries', date, id, 'metadata.json'));
          if (entry.schema_version !== 1 || entry.entry_id !== id || entry.date !== date || !validSteps(entry, entrySteps)
            || !Number.isFinite(Date.parse(entry.received_at)) || !Number.isSafeInteger(entry.telegram_user_id)
            || !Number.isSafeInteger(entry.telegram_message_id)) throw new Error('Invalid metadata');
          entries.push(entry);
          for (const [key, name] of [['transcription', 'transcript.md'], ['entry_summary', 'summary.md']]) {
            if (entry.steps[key].status === 'complete' && !await exists(join(entryPath(entry), name))) {
              issues.push({ date, id, operation: `missing_${key}_file` });
            }
          }
          const removalPermitted = entry.local_audio_removal_authorized && entry.steps.transcription.status === 'complete' && entry.steps.drive_audio.status === 'complete';
          if (entry.steps.telegram_audio_download.status === 'complete' && !removalPermitted && !entry.local_audio_removed
            && !await exists(join(entryPath(entry), 'audio.ogg'))) issues.push({ date, id, operation: 'missing_audio_file' });
        } catch { issues.push({ date, id, operation: 'invalid_entry_metadata' }); }
      }
    }
    for (const date of (await directories(join(root, 'days'))).filter(validateDate)) {
      try {
        const day = await readJson(join(root, 'days', date, 'metadata.json'));
        if (day.schema_version !== 1 || day.date !== date || !validSteps(day, daySteps)) throw new Error('Invalid metadata');
        days.push(day);
        if (day.steps.daily_summary.status === 'complete' && !await exists(join(dayPath(day), 'summary.md'))) {
          issues.push({ date, id: date, operation: 'missing_daily_summary_file' });
        }
      } catch { issues.push({ date, id: date, operation: 'invalid_day_metadata' }); }
    }
    entries.sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at) || a.telegram_message_id - b.telegram_message_id);
    return { entries, days, issues };
  }
  const writeEntry = entry => atomicWriteJson(join(entryPath(entry), 'metadata.json'), entry);
  const writeDay = day => atomicWriteJson(join(dayPath(day), 'metadata.json'), day);
  async function getDay(date) {
    if (!validateDate(date)) throw new Error('Invalid calendar date');
    const day = await readJson(join(dayPath(date), 'metadata.json'), null);
    if (day) {
      if (day.schema_version !== 1 || day.date !== date || !validSteps(day, daySteps)) throw new Error('Invalid day metadata');
      return day;
    }
    const fresh = makeDay(date);
    await writeDay(fresh);
    return fresh;
  }
  async function init() {
    for (const name of ['entries', 'days', 'aggregates', 'status']) await mkdir(join(root, name), { recursive: true, mode: 0o700 });
    const path = join(root, 'state.json');
    let state = await readJson(path, null);
    if (!state) {
      const { entries, days } = await scan();
      const dates = [config.diaryStartDate || localDate(now()), ...entries.map(e => e.date), ...days.map(d => d.date)].sort();
      state = { schema_version: 1, start_date: dates[0], last_poll_drained_at: null };
      await atomicWriteJson(path, state);
    }
    if (state.schema_version !== 1 || !validateDate(state.start_date)) throw new Error('Invalid diary state');
    return state;
  }
  return { root, entryPath, dayPath, scan, writeEntry, writeDay, getDay, init,
    readState: () => readJson(join(root, 'state.json')),
    writeState: state => atomicWriteJson(join(root, 'state.json'), state) };
}
