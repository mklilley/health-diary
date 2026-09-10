import { addDays, localDate, validateDate } from '../util/dates.js';

export const SISTER_HELP = 'Send a voice note about what you have eaten and how you have been feeling. I will keep the recording and reply with a short summary. Send corrections as a new voice note. Text messages are not added to your diary.';
export const ADMIN_HELP = [
  'Health Diary admin commands:',
  '/status — current operational status',
  '/retry — retry outstanding operations now',
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
  if (role === 'sister') {
    if (command?.name === 'help' || command?.name === 'start') return SISTER_HELP;
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
