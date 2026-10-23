import { join } from 'node:path';
import { atomicWriteJson, readJson } from '../util/atomic-write.js';
import { withLock } from '../util/lock.js';
import { safeError } from '../util/logging.js';
import { isTransient } from '../util/retry.js';
import { pendingStep } from './metadata.js';
import { updateAlerts } from './alerts.js';

// One Telegram connection and incident history, independent of diary writers.
export async function createPollingState({ config, services, now }) {
  const path = join(config.dataDir, 'polling.json');
  const locked = action => withLock(config.dataDir, action, { name: 'polling' });
  const readState = async () => {
    const state = await readJson(path);
    if (state.schema_version !== 1 || state.kind !== 'polling' || !state.steps || !state.notifications
      || (state.last_poll_drained_at !== null && !Number.isFinite(Date.parse(state.last_poll_drained_at)))) {
      throw new Error('Invalid Telegram polling state');
    }
    return state;
  };
  const writeState = state => atomicWriteJson(path, state);
  const ctx = { config, services, now, store: {
    root: config.dataDir, readState, writeState,
    scan: async () => ({ entries: [], days: [], issues: [] }),
  } };
  await locked(async () => {
    if (await readJson(path, null) === null) await writeState({ schema_version: 1, kind: 'polling',
      date: 'Telegram bot', last_poll_drained_at: null, steps: {}, notifications: {} });
    await readState();
  });
  return {
    recordPoll: (at = now()) => locked(async () => {
      const state = await readState();
      state.last_poll_drained_at = new Date(at).toISOString();
      if (state.steps.telegram_poll) {
        Object.assign(state.steps.telegram_poll, { status: 'complete', completed_at: new Date(at).toISOString(), last_error: null });
        delete state.steps.telegram_poll.first_failure_at;
        await updateAlerts(ctx, state, writeState);
      } else await writeState(state);
    }),
    recordPollFailure: error => locked(async () => {
      const state = await readState();
      const step = state.steps.telegram_poll ||= pendingStep();
      if (step.status === 'complete') { step.alert_sent = false; step.resolved_alert_sent = false; }
      step.attempts++;
      step.first_failure_at ||= now().toISOString();
      step.last_attempt_at = now().toISOString();
      step.last_error = safeError(error);
      const aged = now().getTime() - Date.parse(step.first_failure_at) >= (config.attentionAfterMs ?? 3_600_000);
      step.status = aged || !isTransient(error) ? 'attention' : 'retry';
      await updateAlerts(ctx, state, writeState);
    }),
  };
}
