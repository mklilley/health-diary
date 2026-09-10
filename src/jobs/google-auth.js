import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { google } from 'googleapis';
import { loadConfig, ConfigurationError } from '../config.js';
import { readGoogleClient, makeGoogleAuth, GOOGLE_SCOPE } from '../services/google-auth.js';
import { createSheetsService } from '../services/google-sheets.js';
import { FOLDER_MIME, SHEET_MIME } from '../services/google-drive.js';
import { safeServiceError, ServiceError } from '../services/errors.js';
import { atomicWriteJson } from '../util/atomic-write.js';

export function validOAuthState(actual, expected) {
  if (typeof actual !== 'string') return false;
  const supplied = Buffer.from(actual);
  const known = Buffer.from(expected);
  return supplied.length === known.length && timingSafeEqual(supplied, known);
}

export async function authorizeGoogle(config, { print = console.log, timeoutMs = 300000 } = {}) {
  const client = await readGoogleClient(config.googleCredentialsFile);
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  let resolveCode;
  let rejectCode;
  const codePromise = new Promise((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Register a handler immediately so a server error cannot cause an unhandled rejection.
  codePromise.catch(() => {});
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    let url;
    try { url = new URL(request.url, 'http://127.0.0.1'); }
    catch { response.writeHead(400).end('Invalid authorization callback.'); return; }
    if (request.method !== 'GET' || url.pathname !== '/' || !validOAuthState(url.searchParams.get('state'), state)) {
      response.writeHead(400).end('Invalid authorization callback.');
      return;
    }
    if (url.searchParams.has('error')) {
      response.writeHead(400).end('Authorization was not granted. Return to the terminal.');
      rejectCode(new ServiceError('google-auth', 'AUTHORIZATION_DENIED'));
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) { response.writeHead(400).end('Missing authorization code.'); return; }
    response.end('Authorization received. You can close this tab and return to the terminal.');
    resolveCode(code);
  });
  server.on('error', () => rejectCode(new ServiceError('google-auth', 'LOOPBACK_LISTENER_FAILED')));
  let timeout;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const redirectUri = `http://127.0.0.1:${server.address().port}`;
    const auth = makeGoogleAuth(client, config, redirectUri);
    const url = auth.generateAuthUrl({
      access_type: 'offline', prompt: 'consent', scope: [GOOGLE_SCOPE],
      state, code_challenge: challenge, code_challenge_method: 'S256',
    });
    print('Open this URL in a browser on the same computer. Sign in with the diary archive owner account:');
    print(url);
    timeout = setTimeout(() => rejectCode(new ServiceError('google-auth', 'AUTHORIZATION_TIMEOUT')), timeoutMs);
    const code = await codePromise;
    const { tokens } = await auth.getToken({ code, codeVerifier: verifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) throw new ConfigurationError('Google did not return a refresh token. Revoke this app grant and rerun google-auth with consent.');
    await atomicWriteJson(config.googleTokenFile, { refresh_token: tokens.refresh_token, scope: tokens.scope ?? GOOGLE_SCOPE });
    auth.setCredentials(tokens);
    return auth;
  } finally {
    clearTimeout(timeout);
    await new Promise((resolve) => server.close(resolve));
  }
}

export async function provisionGoogleArchive(config, auth, { client = google.drive({ version: 'v3', auth }), sheetsFactory = createSheetsService } = {}) {
  const options = { retry: false, timeout: config.httpTimeoutMs };
  const fields = 'id,name,mimeType,parents,trashed,permissions(type,role)';
  const ensure = async ({ id, parentId, name, mimeType }) => {
    let file;
    if (id) file = (await client.files.get({ fileId: id, fields }, options)).data;
    else {
      const { data } = await client.files.list({
        q: `'${parentId}' in parents and name = '${name}' and trashed = false`, fields: `nextPageToken,files(${fields})`, pageSize: 100,
      }, options);
      if (data.nextPageToken || data.files?.length > 1) throw new ServiceError('google-auth', 'DUPLICATE_SETUP_OBJECT');
      file = data.files?.[0];
      if (!file) file = (await client.files.create({ requestBody: { name, mimeType, parents: [parentId] }, fields }, options)).data;
    }
    if (!file?.id || file.trashed || file.mimeType !== mimeType || (parentId !== 'root' && !file.parents?.includes(parentId))) {
      throw new ServiceError('google-auth', 'SETUP_OBJECT_CONFLICT');
    }
    // Never write private health records under a folder already shared with others.
    if (!file.permissions?.length || file.permissions.some((permission) => permission.role !== 'owner')) {
      throw new ServiceError('google-auth', 'ARCHIVE_MUST_BE_PRIVATE');
    }
    return file.id;
  };
  const rootId = await ensure({ id: config.googleDriveRootFolderId, parentId: 'root', name: 'Health Diary', mimeType: FOLDER_MIME });
  const sheetId = await ensure({ id: config.googleSheetId, parentId: rootId, name: 'Diary Index', mimeType: SHEET_MIME });
  await sheetsFactory({ ...config, googleSheetId: sheetId }, { auth }).ensureTabs();
  return { rootId, sheetId };
}

export async function runGoogleAuth() {
  process.umask(0o077);
  const config = loadConfig({ requireSecrets: false });
  const auth = await authorizeGoogle(config);
  console.log('Refresh token saved with private permissions. Preparing the private archive and index…');
  const { rootId, sheetId } = await provisionGoogleArchive(config, auth);
  console.log(`Add these values to .env:\nGOOGLE_DRIVE_ROOT_FOLDER_ID=${rootId}\nGOOGLE_SHEET_ID=${sheetId}`);
  console.log('Do not run a second copy of the bot against the same Telegram token or diary archive.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGoogleAuth().catch((error) => {
    console.error(error instanceof ConfigurationError ? error.message : safeServiceError('google-auth', error).message);
    process.exitCode = 1;
  });
}
