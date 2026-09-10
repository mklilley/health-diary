import { readFile } from 'node:fs/promises';
import { google } from 'googleapis';
import { ConfigurationError } from '../config.js';

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export async function readGoogleClient(path) {
  let json;
  try { json = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new ConfigurationError('Cannot read Google OAuth client JSON. Check GOOGLE_CREDENTIALS_FILE.'); }
  const client = json.installed;
  if (!client?.client_id || !client?.client_secret) {
    throw new ConfigurationError('Google credentials must be a downloaded Desktop app OAuth client JSON.');
  }
  return client;
}

export function makeGoogleAuth(client, config, redirectUri) {
  const auth = new google.auth.OAuth2({
    clientId: client.client_id, clientSecret: client.client_secret, redirectUri,
    transporterOptions: { retry: false, timeout: config.httpTimeoutMs },
    useAuthRequestParameters: false,
  });
  // The auth library explicitly enables refresh-request retries, overriding defaults.
  // Apply the policy at its supported transport boundary as well as API calls.
  auth.transporter.interceptors.request.add({ resolved: (options) => ({
    ...options, retry: false, retryConfig: { retry: 0 }, timeout: config.httpTimeoutMs,
  }) });
  return auth;
}

export async function loadGoogleAuth(config) {
  const client = await readGoogleClient(config.googleCredentialsFile);
  let tokens;
  try { tokens = JSON.parse(await readFile(config.googleTokenFile, 'utf8')); }
  catch { throw new ConfigurationError('Cannot read Google token JSON. Run npm run google-auth first.'); }
  if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
    throw new ConfigurationError('Google token JSON has no refresh token. Run npm run google-auth again.');
  }
  const auth = makeGoogleAuth(client, config);
  // Refresh tokens are durable; short-lived access tokens are refreshed in memory.
  auth.setCredentials({ refresh_token: tokens.refresh_token });
  return auth;
}
