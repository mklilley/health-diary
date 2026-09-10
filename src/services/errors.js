const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOENT', 'EACCES']);

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
  const code = status ? `HTTP_${status}` : NETWORK_CODES.has(error?.code) ? error.code
    : error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'REQUEST_ABORTED' : 'REQUEST_FAILED';
  return new ServiceError(service, code, status);
}

export async function guarded(service, work) {
  try { return await work(); }
  catch (error) { throw safeServiceError(service, error); }
}
