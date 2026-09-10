import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { google } from 'googleapis';
import { guarded, ServiceError } from './errors.js';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const FILE_FIELDS = 'id,name,mimeType,parents,trashed,size,md5Checksum,webViewLink';
const quote = (value) => String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'");

export function createDriveService(config, { auth, client = google.drive({ version: 'v3', auth }) } = {}) {
  const options = { retry: false, timeout: config.httpTimeoutMs };
  const find = async (parentId, name) => {
    const files = [];
    let pageToken;
    do {
      const { data } = await client.files.list({
        q: `'${quote(parentId)}' in parents and name = '${quote(name)}' and trashed = false`,
        spaces: 'drive', fields: `nextPageToken,files(${FILE_FIELDS})`, pageSize: 100, pageToken,
      }, options);
      files.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    if (files.length > 1) throw new ServiceError('drive', 'DUPLICATE_REMOTE_OBJECT');
    return files[0] ?? null;
  };
  const assertTarget = (file, parentId, name, mimeType) => {
    if (!file?.id || file.trashed || file.name !== name || file.mimeType !== mimeType
      || !file.parents?.includes(parentId)) throw new ServiceError('drive', 'REMOTE_OBJECT_CONFLICT');
  };
  const get = async (fileId) => (await client.files.get({ fileId, fields: FILE_FIELDS }, options)).data;
  const reference = (file) => ({ id: file.id, webViewLink: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view` });
  return {
    ensureFolder: (parentId, name) => guarded('drive', async () => {
      const existing = await find(parentId, name);
      if (existing) {
        assertTarget(existing, parentId, name, FOLDER_MIME);
        return { id: existing.id };
      }
      const { data } = await client.files.create({
        requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] }, fields: FILE_FIELDS,
      }, options);
      assertTarget(data, parentId, name, FOLDER_MIME);
      return { id: data.id };
    }),
    putFile: ({ parentId, name, path, mimeType, fileId, mutable = false }) => guarded('drive', async () => {
      const hash = createHash('md5');
      let size = 0;
      for await (const chunk of createReadStream(path)) { size += chunk.length; hash.update(chunk); }
      const md5 = hash.digest('hex');
      let existing;
      if (fileId) {
        // A persisted ID is authoritative. Never replace an inaccessible archive silently.
        existing = await get(fileId);
      } else existing = await find(parentId, name);
      if (existing) {
        assertTarget(existing, parentId, name, mimeType);
        if (Number(existing.size) === size && existing.md5Checksum === md5) return reference(existing);
        if (!mutable) throw new ServiceError('drive', 'IMMUTABLE_CONTENT_CONFLICT');
      }
      const stream = createReadStream(path);
      let uploaded;
      try {
        const media = { mimeType, body: stream };
        uploaded = existing
          ? (await client.files.update({ fileId: existing.id, media, fields: FILE_FIELDS }, options)).data
          : (await client.files.create({ requestBody: { name, mimeType, parents: [parentId] }, media, fields: FILE_FIELDS }, options)).data;
      } finally { stream.destroy(); }
      if (!uploaded?.id) throw new ServiceError('drive', 'INVALID_RESPONSE');
      if (uploaded.md5Checksum === undefined || uploaded.size === undefined) uploaded = await get(uploaded.id);
      assertTarget(uploaded, parentId, name, mimeType);
      if (Number(uploaded.size) !== size || uploaded.md5Checksum !== md5) throw new ServiceError('drive', 'UPLOAD_CHECKSUM_MISMATCH');
      return reference(uploaded);
    }),
  };
}
