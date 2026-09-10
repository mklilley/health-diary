import { setTimeout } from 'node:timers/promises';
import { withLock } from '../util/lock.js';
import { createStepRunner, isTransient } from '../util/retry.js';
import { safeError } from '../util/logging.js';
import { createStore, pendingStep } from './metadata.js';
import { receiveVoice, processEntry } from './entries.js';
import { finaliseDays, sendReminder } from './days.js';
import { rebuildAggregates } from './aggregates.js';
import { rebuildStatus, statusIndex, showDay, lastDay } from './status.js';

// Public operations share one writer lock across PM2, timers and manual jobs.
// Helpers called inside a public operation deliberately do not acquire it again.
export async function createDiary({ config, services = {}, now = () => new Date(), sleep = setTimeout, random = Math.random }) {
  const store = createStore(config, now);
  const ctx = { config, services, now, sleep, random, store };
  ctx.runner = createStepRunner(ctx);
  const locked = action => withLock(config.dataDir, action);
  await locked(() => store.init());
  async function flushAlerts() {
    const state = await store.readState();
    state.steps ||= {};
    await ctx.runner.alerts(state, store.writeState);
  }
  async function refresh({ upload = false, force = false } = {}) {
    await rebuildAggregates(ctx, { upload, force });
    if (upload) await flushAlerts();
    await rebuildStatus(ctx);
  }
  return {
    receiveVoice: message => locked(() => receiveVoice(ctx, message)),
    processEntry: entryId => locked(async () => {
      const { entries } = await store.scan();
      const entry = entries.find(entry => entry.entry_id === entryId);
      if (!entry) throw new Error('Entry not found or metadata needs attention');
      const result = await processEntry(ctx, entry);
      await refresh({ upload: true });
      return result;
    }),
    retry: ({ force = false } = {}) => locked(async () => {
      const before = await statusIndex(ctx);
      const { entries } = await store.scan();
      for (const entry of entries) await processEntry(ctx, entry, { force });
      const state = await store.readState();
      if (state.steps) await ctx.runner.alerts(state, store.writeState);
      await finaliseDays(ctx, { force });
      await sendReminder(ctx);
      await refresh({ upload: true, force });
      const after = await statusIndex(ctx);
      const key = operation => `${operation.id}/${operation.operation}`;
      const outstanding = new Set(after.operations.map(key));
      return { checked: before.operations.length, resolved: before.operations.filter(op => !outstanding.has(key(op))).length,
        retrying: after.outstanding_retries, attention: after.needs_attention };
    }),
    daily: () => locked(async () => { const result = await finaliseDays(ctx); await refresh({ upload: true }); return result; }),
    reminder: () => locked(async () => { const result = await sendReminder(ctx); await flushAlerts(); await rebuildStatus(ctx); return result; }),
    status: () => locked(() => rebuildStatus(ctx)),
    rebuildAggregates: () => locked(async () => { const result = await rebuildAggregates(ctx); await rebuildStatus(ctx); return result; }),
    showDay: date => locked(() => showDay(ctx, date)),
    lastDay: () => locked(() => lastDay(ctx)),
    recordPoll: (at = now()) => locked(async () => {
      const state = await store.readState();
      state.last_poll_drained_at = new Date(at).toISOString();
      if (state.steps?.telegram_poll) {
        Object.assign(state.steps.telegram_poll, { status: 'complete', completed_at: new Date(at).toISOString(), last_error: null });
        delete state.steps.telegram_poll.first_failure_at;
        await ctx.runner.alerts(state, store.writeState);
      }
      await store.writeState(state);
    }),
    recordPollFailure: error => locked(async () => {
      const state = await store.readState();
      state.date = 'Telegram bot';
      state.steps ||= {};
      const step = state.steps.telegram_poll ||= pendingStep();
      if (step.status === 'complete') {
        step.alert_sent = false;
        step.resolved_alert_sent = false;
      }
      step.attempts++;
      step.first_failure_at ||= now().toISOString();
      step.last_attempt_at = now().toISOString();
      step.last_error = safeError(error);
      const aged = now().getTime() - Date.parse(step.first_failure_at) >= (config.attentionAfterMs ?? 3_600_000);
      step.status = aged || !isTransient(error) ? 'attention' : 'retry';
      await store.writeState(state);
      await ctx.runner.alerts(state, store.writeState);
      await rebuildStatus(ctx);
    }),
  };
}
