import { join } from 'node:path';
import { readJson } from '../util/atomic-write.js';
import { safeError } from '../util/logging.js';

function incidentKey(meta, key, step) {
  // One provider outage can fail several files and several entries. Notify once
  // for that shared problem; individual uncertain messages remain separate.
  if (step.ambiguous_delivery) return `telegram:${meta.entry_id || meta.date}:${key}`;
  const service = key.startsWith('drive_') || key.endsWith('.md') ? 'Google Drive'
    : key.startsWith('sheet_') ? 'Google Sheets' : key.startsWith('telegram_') ? 'Telegram'
      : key === 'daily_summary' && step.last_error?.type === 'dependency' ? 'Daily sources' : 'OpenAI';
  return `${service}:${step.last_error?.code || 'OPERATION_FAILED'}`;
}

export async function updateAlerts(ctx, meta, save) {
  meta.attention ||= {};
  meta.attention.required = Object.values(meta.steps).some(step => step.status === 'attention');
  await save(meta);
  const state = await ctx.store.readState();
  state.notifications ||= {};
  const { entries, days, issues } = await ctx.store.scan();
  let aggregates;
  try { aggregates = await readJson(join(ctx.store.root, 'aggregates', 'metadata.json'), null); } catch { /* Status reports corrupt derived state. */ }
  const records = [...entries, ...days, state, ...(aggregates?.steps ? [aggregates] : [])];
  const active = new Map();
  if (issues.length) active.set('Local files:LOCAL_SOURCE_INVALID', issues.map(issue => `${issue.id}: ${issue.operation}`));
  for (const day of days) {
    if (day.reminder_sent && day.reminder?.status !== 'complete') {
      active.set(`Telegram reminder:${day.date}`, [`${day.date}: reminder delivery unconfirmed; check the chat`]);
    }
  }
  for (const record of records) {
    for (const [key, step] of Object.entries(record.steps || {})) {
      if (!step || step.status === 'complete') continue;
      const incident = incidentKey(record, key, step);
      if (step.status !== 'attention' && !state.notifications[incident]?.active) continue;
      const refs = active.get(incident) || [];
      refs.push(`${record.entry_id || record.date || 'aggregates'}: ${key}`);
      active.set(incident, refs);
    }
  }
  for (const [key, references] of active) {
    if (!state.notifications[key]?.active) state.notifications[key] = { active: true, opened_at: ctx.now().toISOString(), references };
    else state.notifications[key].references = references;
  }
  for (const [key, incident] of Object.entries(state.notifications)) {
    if (!incident.active) continue;
    const resolving = !active.has(key);
    const flag = resolving ? 'resolution_reserved' : 'alert_reserved';
    if (incident[flag]) { if (resolving) incident.active = false; continue; }
    if (incident.next_notification_at && Date.parse(incident.next_notification_at) > ctx.now().getTime()) continue;
    // This reservation survives a crash after Telegram accepts the message.
    incident[flag] = true;
    await ctx.store.writeState(state);
    const references = incident.references.slice(0, 6).join('\n');
    const text = resolving
      ? `✅ Health Diary issue resolved\n\n${key}\n${references}`
      : `⚠️ Health Diary needs attention\n\n${key}\n${references}\n\nUse /status for details.`;
    try {
      const result = await ctx.services.telegram.sendMessage(ctx.config.adminUserId, text);
      incident[`${flag}_message_id`] = result.message_id;
      delete incident.notification_error;
      delete incident.delivery_uncertain;
      delete incident.next_notification_at;
    } catch (error) {
      const safe = safeError(error);
      incident.notification_error = safe;
      if (!error?.ambiguousDelivery && safe.status && safe.status < 500 && safe.status !== 408) {
        incident[flag] = false;
        incident.next_notification_at = new Date(ctx.now().getTime() + (ctx.config.retryIntervalMs || 900_000)).toISOString();
      } else incident.delivery_uncertain = true;
    }
    if (resolving && incident[flag]) incident.active = false;
    await ctx.store.writeState(state);
  }
  await ctx.store.writeState(state);
  // Retain useful notification state beside the operation as well as the shared
  // incident reservation; the latter prevents duplicates across entries/jobs.
  for (const [key, step] of Object.entries(meta.steps)) {
    if (step.status === 'attention') step.incident_key = incidentKey(meta, key, step);
    const incident = state.notifications[step.incident_key];
    if (!incident) continue;
    step.alert_sent = Boolean(incident.alert_reserved);
    step.resolved_alert_sent = Boolean(incident.resolution_reserved);
  }
  meta.attention.alert_sent = Object.values(meta.steps).some(step => step.alert_sent);
  meta.attention.resolved_alert_sent = Object.values(meta.steps).some(step => step.resolved_alert_sent);
  // Polling state and notification reservations share state.json.
  if (meta.start_date) meta.notifications = state.notifications;
  await save(meta);
}
