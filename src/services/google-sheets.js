import { google } from 'googleapis';
import { guarded, ServiceError } from './errors.js';

export const ENTRY_HEADERS = ['Entry ID', 'Received date/time', 'Short summary', 'Audio link', 'Transcript link'];
export const DAY_HEADERS = ['Date', 'Daily summary', 'Number of entries'];

export function createSheetsService(config, { auth, client = google.sheets({ version: 'v4', auth }) } = {}) {
  const spreadsheetId = config.googleSheetId;
  const options = { retry: false, timeout: config.httpTimeoutMs };
  const readTab = async (tab, headers) => {
    const { data: workbook } = await client.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties' }, options);
    if (!workbook.sheets?.some((sheet) => sheet.properties.title === tab)) {
      await client.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: tab } } }] } }, options);
    }
    const column = String.fromCharCode(64 + headers.length);
    const range = `'${tab}'!A:${column}`;
    const { data } = await client.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption: 'UNFORMATTED_VALUE' }, options);
    const rows = data.values ?? [];
    if (!rows.length || rows.every((row) => row.every((cell) => cell === ''))) {
      await client.spreadsheets.values.update({ spreadsheetId, range: `'${tab}'!A1:${column}1`, valueInputOption: 'RAW', requestBody: { values: [headers] } }, options);
      return { rows: [headers], column, range };
    }
    if (headers.some((header, index) => rows[0]?.[index] !== header)) {
      throw new ServiceError('sheets', 'HEADER_MISMATCH');
    }
    return { rows, column, range };
  };
  const upsert = (tab, headers, row) => guarded('sheets', async () => {
    // Always scan again, including after a response was lost from a prior append.
    const { rows, column, range } = await readTab(tab, headers);
    const matches = rows.map((current, index) => String(current[0]) === String(row[0]) && index > 0 ? index : -1).filter((index) => index >= 0);
    if (matches.length > 1) throw new ServiceError('sheets', 'DUPLICATE_REMOTE_KEY');
    if (matches.length) {
      const index = matches[0];
      if (row.every((cell, position) => String(rows[index][position] ?? '') === String(cell))) return { row: index + 1 };
      await client.spreadsheets.values.update({
        spreadsheetId, range: `'${tab}'!A${index + 1}:${column}${index + 1}`, valueInputOption: 'RAW', requestBody: { values: [row] },
      }, options);
      return { row: index + 1 };
    }
    const { data } = await client.spreadsheets.values.append({
      spreadsheetId, range, valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: [row] },
    }, options);
    return { updatedRange: data.updates?.updatedRange };
  });
  return {
    upsertEntry: ({ entryId, receivedAt, summary, audioLink, transcriptLink }) => upsert('Entries', ENTRY_HEADERS,
      [entryId, receivedAt, summary, audioLink, transcriptLink]),
    upsertDay: ({ date, summary, entryCount }) => upsert('Days', DAY_HEADERS, [date, summary, entryCount]),
    ensureTabs: () => guarded('sheets', async () => {
      await readTab('Entries', ENTRY_HEADERS);
      await readTab('Days', DAY_HEADERS);
    }),
  };
}
