import { safeError, log } from './logging.js';
import { pendingStep } from '../diary/metadata.js';
import { updateAlerts } from '../diary/alerts.js';

export function isTransient(error) {
  const e = safeError(error);
  if (['DUPLICATE_REMOTE_OBJECT', 'REMOTE_OBJECT_CONFLICT', 'IMMUTABLE_CONTENT_CONFLICT', 'HEADER_MISMATCH',
    'DUPLICATE_REMOTE_KEY', 'MODEL_REFUSAL', 'CONFIGURATION_ERROR', 'FILE_TOO_LARGE', 'AUDIO_TOO_LARGE', 'INVALID_FILE_PATH',
    'INVALID_AUDIO', 'ENOENT', 'EACCES', 'ENOSPC', 'EIO'].includes(e.code)) return false;
  return !e.status || e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
}

export function createStepRunner(ctx) {
  const { config, now, sleep, random } = ctx;
  async function run(meta, key, save, action, { force = false, telegram = false } = {}) {
    const step = meta.steps[key] ||= pendingStep();
    if (step.status === 'complete' || step.ambiguous_delivery) return step.status === 'complete';
    if (!force && step.next_retry_at && Date.parse(step.next_retry_at) > now().getTime()) return false;
    if (telegram && step.status === 'running') {
      step.status = 'attention';
      step.ambiguous_delivery = true;
      step.last_error = { type: 'delivery', code: 'AMBIGUOUS_DELIVERY', message: 'Previous Telegram send may have succeeded; verify chat before manual recovery' };
      await save(meta);
      return false;
    }
    const attempts = config.immediateAttempts ?? 3;
    for (let i = 0; i < attempts; i++) {
      step.status = 'running';
      step.attempts++;
      step.last_attempt_at = now().toISOString();
      await save(meta);
      try {
        const result = await action(step);
        Object.assign(step, result || {}, { status: 'complete', completed_at: now().toISOString(), next_retry_at: null, last_error: null });
        delete step.first_failure_at;
        await save(meta);
        log('operation_complete', { entry_id: meta.entry_id, date: meta.date, step: key });
        return true;
      } catch (error) {
        const safe = safeError(error);
        step.first_failure_at ||= now().toISOString();
        step.last_error = safe;
        const ambiguous = telegram && (error?.ambiguousDelivery || !safe.status || safe.status >= 500 || safe.status === 408);
        const aged = now().getTime() - Date.parse(step.first_failure_at) >= (config.attentionAfterMs ?? 3_600_000);
        step.status = !isTransient(error) || aged || ambiguous ? 'attention' : 'retry';
        const providerDelay = Number(error?.retryAfterSeconds ?? error?.parameters?.retry_after) * 1000;
        const retryDelay = Math.max(config.retryIntervalMs ?? 900_000, Number.isFinite(providerDelay) ? providerDelay : 0);
        step.next_retry_at = new Date(now().getTime() + retryDelay).toISOString();
        if (ambiguous) { step.ambiguous_delivery = true; step.last_error = { ...safe, message: 'Telegram delivery uncertain; verify chat before manual recovery' }; }
        await save(meta);
        log('operation_failed', { entry_id: meta.entry_id, date: meta.date, step: key, attempt: step.attempts, code: safe.code });
        if (!isTransient(error) || ambiguous || i === attempts - 1 || providerDelay > 60_000) return false;
        const delay = (config.retryBaseMs ?? 1000) * 2 ** i * (0.8 + random() * 0.4);
        await sleep(Math.min(60_000, Math.max(delay, Number.isFinite(providerDelay) ? providerDelay : 0)));
      }
    }
    return false;
  }

  const alerts = (meta, save) => updateAlerts(ctx, meta, save);
  return { run, alerts };
}
