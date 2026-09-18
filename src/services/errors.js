const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'ENOENT', 'EACCES']);

export class ServiceError extends Error {
  constructor(service, code, status) {
    super(`${service} operation failed: ${status ? `HTTP ${status}` : code}`);
    this.name = 'ServiceError';
    this.service = service;
    this.code = code;
    if (status) this.status = status;
  }
}

// API errors can embed prompts, URLs, tokens and response bodies. Never retain the cause.
export function safeServiceError(service, error) {
  if (error instanceof ServiceError) return error;
  const candidate = Number(error?.status ?? error?.response?.status ?? error?.code);
  const status = Number.isInteger(candidate) && candidate >= 100 && candidate <= 599 ? candidate : undefined;
  // Node fetch puts connection errors in cause. Copy only a recognised code;
  // the cause's message, URL and other fields can contain credentials.
  const networkCode = [error?.code, error?.cause?.code].find(code => NETWORK_CODES.has(code));
  const code = status ? `HTTP_${status}` : networkCode ? networkCode
    : error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'REQUEST_ABORTED' : 'REQUEST_FAILED';
  return new ServiceError(service, code, status);
}

export async function guarded(service, work) {
  try { return await work(); }
  catch (error) { throw safeServiceError(service, error); }
}
