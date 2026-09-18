import { addDays, localDate, validateDate } from '../util/dates.js';

export const DIARY_USER_HELP = 'Send a voice note about what you have eaten and how you have been feeling. I will keep the recording and reply with a short summary. Send corrections as a new voice note. Text messages are not added to your diary.';
export const ADMIN_HELP = [
  'Health Diary admin commands:',
  '/status — current operational status',
  '/retry — retry outstanding operations now',
  '/export — generate combined diary files in Drive',
  '/day YYYY-MM-DD — view a day',
  '/today — view today',
  '/yesterday — view yesterday',
  '/last — most recent completed daily summary',
  '/help — show this help',
  '',
  'Admin voice notes are not added to the diary.',
].join('\n');

export function parseCommand(text) {
  if (typeof text !== 'string') return null;
  const match = text.trim().match(/^\/([a-z][a-z0-9_]*)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  return match ? { name: match[1].toLowerCase(), argument: (match[3] ?? '').trim() } : null;
}

/** Only the admin branch can reach a diary read or maintenance operation. */
export async function commandReply(text, { role, app, now = () => new Date() }) {
  const command = parseCommand(text);
  if (role === 'diary_user') {
    if (command?.name === 'help' || command?.name === 'start') return DIARY_USER_HELP;
    return 'Please send diary entries as voice notes. Type /help for help.';
  }
  if (role !== 'admin') return null;
  if (!command) return 'Type /help for the available admin commands.';

  switch (command.name) {
    case 'start':
    case 'help':
      return ADMIN_HELP;
    case 'status':
      return app.status();
    case 'export': {
      if (command.argument) return 'Use /export without arguments to export all saved diary text.';
      const result = await app.exportAggregates();
      if (!result.rebuilt) return 'Export could not be generated because some source files need attention. Existing exports were preserved. Use /status for details.';
      const { snapshot, uploads } = result;
      const lines = [result.uploaded ? 'Export ready.' : 'Export prepared; some uploads are still pending.', '',
        `Generated: ${snapshot.generated_at} (Europe/London)`,
        `Diary entries recorded: ${snapshot.entry_count}`,
        `Transcripts included: ${snapshot.transcript_count}/${snapshot.entry_count}`,
        `Entry summaries included: ${snapshot.entry_summary_count}/${snapshot.entry_count}`,
        `Daily summaries included: ${snapshot.daily_summary_count}`,
        `Entries still processing: ${snapshot.entries_pending}`,
        `Due daily summaries missing: ${snapshot.due_daily_summaries_missing}`, '',
        'This is a snapshot of saved text. Use /export again to include later changes.',
      ];
      for (const file of uploads) {
        if (file.url) lines.push('', file.name, file.url);
        else lines.push('', `${file.name}: upload pending`);
      }
      if (!result.uploaded) lines.push('', 'Scheduled retries will retry this snapshot. Use /status for progress and links, or /retry to retry now.');
      return lines.join('\n');
    }
    case 'retry': {
      const result = await app.retry({ force: true });
      return [
        'Retry complete.', '',
        `Outstanding operations checked: ${result.checked}`,
        `Resolved: ${result.resolved}`,
        `Still retrying: ${result.retrying}`,
        `Needs attention: ${result.attention}`,
      ].join('\n');
    }
    case 'day':
      if (!validateDate(command.argument)) return 'Please use /day YYYY-MM-DD with a valid calendar date.';
      return app.showDay(command.argument);
    case 'today':
      return app.showDay(localDate(now()));
    case 'yesterday':
      return app.showDay(addDays(localDate(now()), -1));
    case 'last':
      return app.lastDay();
    default:
      return 'Unknown command. Type /help for the available admin commands.';
  }
}
