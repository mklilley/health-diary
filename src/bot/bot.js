import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicWriteJson, readJson } from '../util/atomic-write.js';
import { withLock } from '../util/lock.js';
import { log, safeError } from '../util/logging.js';
import { createRuntime, isMain, reportFailure } from '../runtime.js';
import { handleUpdate, isDiaryVoice, messageRole } from './handlers.js';

async function pause(milliseconds, signal) {
  try { await delay(milliseconds, undefined, { signal }); }
  catch (error) { if (!signal?.aborted) throw error; }
}

/**
 * A poller lease prevents two processes acknowledging the same Telegram queue.
 * Writer locks inside diary methods also coordinate the one-shot jobs.
 *
 * Commit the Telegram cursor only after a voice receipt is on disk. Drain every
 * available batch before running work which could complete a calendar day.
 */
export async function runBot({
  app, services, config, signal, now = () => new Date(), sleep = pause,
  logger = log, maxCycles = Infinity, recoverOnStart = true,
}) {
  return withLock(config.dataDir, async () => {
    const cursorPath = join(config.dataDir, 'telegram.json');
    const cursor = await readJson(cursorPath, { schema_version: 1, next_offset: 0 });
    if (cursor.schema_version !== 1 || !Number.isSafeInteger(cursor.next_offset) || cursor.next_offset < 0) {
      throw Object.assign(new Error('Invalid Telegram cursor state'), { code: 'INVALID_TELEGRAM_CURSOR' });
    }
    let nextOffset = cursor.next_offset;
    let failures = 0;
    let cycle = 0;
    let recoveryPending = recoverOnStart;
    const entries = new Set();
    const interactions = [];

    logger('bot_started');
    if (typeof process.send === 'function') process.send('ready');

    while (!signal?.aborted && cycle < maxCycles) {
      try {
        let updates = await services.telegram.getUpdates({ offset: nextOffset, timeout: 30, signal });
        while (!signal?.aborted) {
          if (!Array.isArray(updates)) throw Object.assign(new Error('Invalid Telegram updates response'), { code: 'INVALID_TELEGRAM_RESPONSE' });
          for (const update of updates) {
            if (!Number.isSafeInteger(update?.update_id) || update.update_id < 0) {
              throw Object.assign(new Error('Invalid Telegram update ID'), { code: 'INVALID_TELEGRAM_RESPONSE' });
            }
          }
          // The API is ordered; sorting also makes mocked/replayed batches safe.
          updates.sort((left, right) => left.update_id - right.update_id);
          for (const update of updates) {
            if (update.update_id < nextOffset) continue;
            let interaction;
            if (isDiaryVoice(update, config)) {
              const entry = await handleUpdate(update, { app, services, config, process: false, now });
              entries.add(entry.entry_id);
            } else if (messageRole(update.message, config)) interaction = update;
            const committedOffset = update.update_id + 1;
            await atomicWriteJson(cursorPath, { schema_version: 1, next_offset: committedOffset });
            nextOffset = committedOffset;
            if (interaction) interactions.push(interaction);
          }

          // Even an empty long poll gets an explicit, immediate drain check.
          const remaining = await services.telegram.getUpdates({ offset: nextOffset, timeout: 0, signal });
          if (!Array.isArray(remaining)) throw Object.assign(new Error('Invalid Telegram updates response'), { code: 'INVALID_TELEGRAM_RESPONSE' });
          if (remaining.length) { updates = remaining; continue; }
          await app.recordPoll(now());
          break;
        }
        if (signal?.aborted) break;
        failures = 0;

        // Persisted operations, including receipts from a prior crash, are the
        // recovery source. This runs after backlog ingestion, never before it.
        if (recoveryPending) {
          try { await app.retry(); }
          catch (error) { logger('startup_recovery_failed', safeError(error)); }
          recoveryPending = false;
        }
        for (const entryId of entries) {
          if (signal?.aborted) break;
          try { await app.processEntry(entryId); }
          catch (error) { logger('entry_processing_failed', { entry_id: entryId, ...safeError(error) }); }
          entries.delete(entryId);
        }
        while (interactions.length && !signal?.aborted) {
          const update = interactions.shift();
          try { await handleUpdate(update, { app, services, config, now }); }
          catch (error) { logger('bot_interaction_failed', safeError(error)); }
        }
        cycle += 1;
      } catch (error) {
        if (signal?.aborted) break;
        failures += 1;
        logger('telegram_poll_failed', safeError(error));
        try { await app.recordPollFailure?.(error); }
        catch (stateError) { logger('poll_failure_state_unavailable', safeError(stateError)); }
        await sleep(Math.min(30_000, 1_000 * 2 ** Math.min(failures - 1, 5)), signal);
      }
    }
    logger('bot_stopped');
  }, { name: 'poller', timeoutMs: 0 });
}

export async function main() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const runtime = await createRuntime();
    await runBot({ ...runtime, signal: controller.signal });
  } catch (error) {
    reportFailure('bot_failed', error);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (isMain(import.meta.url)) await main();
