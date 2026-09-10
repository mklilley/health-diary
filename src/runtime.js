import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigurationError, loadConfig } from './config.js';
import { createServices } from './services/index.js';
import { createDiary } from './diary/index.js';
import { log, safeError } from './util/logging.js';

export function isMain(url) {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(url);
}

export function reportFailure(event, error, fields = {}) {
  // Configuration errors are authored locally and never interpolate values.
  // Provider errors, by contrast, may contain URLs with embedded credentials.
  if (error instanceof ConfigurationError) process.stderr.write(`Configuration error: ${error.message}\n`);
  log(event, { ...fields, ...safeError(error) });
}

export async function createRuntime({ requireSecrets = true, config, services, ...options } = {}) {
  process.umask(0o077);
  const runtimeConfig = config ?? await loadConfig({ requireSecrets });
  const runtimeServices = services ?? (requireSecrets ? await createServices(runtimeConfig) : {});
  const app = await createDiary({ config: runtimeConfig, services: runtimeServices, ...options });
  return { app, config: runtimeConfig, services: runtimeServices };
}

/** Local status, day and rebuild commands require no cloud credentials. */
export async function runJob(name, action, { requireSecrets = true } = {}) {
  try {
    const { app } = await createRuntime({ requireSecrets });
    const result = await action(app);
    if (result !== undefined) process.stdout.write(`${typeof result === 'string' ? result.trimEnd() : JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    reportFailure('job_failed', error, { job: name });
    process.exitCode = 1;
  }
}
