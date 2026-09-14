import { spawn } from 'node:child_process';
import { chmod, mkdir, open, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigurationError } from '../config.js';
import { isMain, reportFailure } from '../runtime.js';
import { withLock } from '../util/lock.js';
import { safeError } from '../util/logging.js';

const rootDirectory = fileURLToPath(new URL('../../', import.meta.url));
const maxRunMs = 45 * 60_000;
const maxLogBytes = 5 * 1024 * 1024;

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export function cronLine({ root = rootDirectory, node = process.execPath } = {}) {
  const quote = value => {
    // Cron interprets percent signs before the shell sees its command.
    if (/[\r\n%]/.test(value)) throw new ConfigurationError('Cron paths must not contain newlines or percent signs.');
    return `'${value.replaceAll("'", "'\\''")}'`;
  };
  return `*/15 * * * * ${quote(node)} ${quote(join(root, 'src/jobs/cron.js'))}`;
}

async function prepareLogs(root) {
  const directory = join(root, 'logs');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  return directory;
}

export async function pauseCron({ root = rootDirectory } = {}) {
  const directory = await prepareLogs(root);
  await writeFile(join(directory, 'cron.paused'), '', { mode: 0o600 });
  // Block new invocations first, then wait for the active invocation to finish.
  await withLock(directory, async () => {}, { name: 'cron', timeoutMs: maxRunMs + 180_000 });
}

export async function resumeCron({ root = rootDirectory } = {}) {
  try { await unlink(join(root, 'logs/cron.paused')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function runCron({ root = rootDirectory, timeoutMs = maxRunMs } = {}) {
  const directory = await prepareLogs(root);
  const paused = () => exists(join(directory, 'cron.paused'));
  if (await paused()) return { code: 0, skipped: 'paused' };
  try {
    return await withLock(directory, async () => {
      if (await paused()) return { code: 0, skipped: 'paused' };
      const path = join(directory, 'cron.log');
      if (await exists(path) && (await stat(path)).size >= maxLogBytes) {
        await rename(path, `${path}.1`);
        await chmod(`${path}.1`, 0o600);
      }
      const output = await open(path, 'a', 0o600);
      try {
        await output.chmod(0o600);
        const record = (event, fields = {}) => output.write(`${JSON.stringify({ time: new Date().toISOString(), event, ...fields })}\n`);
        await record('cron_started');
        // The existing retry pass also finalises due days and checks reminders.
        // Its date guards use Europe/London, regardless of cron's timezone.
        const result = await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [join(root, 'src/jobs/retry.js')], {
            cwd: root,
            env: { ...process.env, NODE_ENV: 'production', TZ: 'Europe/London' },
            stdio: ['ignore', output.fd, output.fd],
            timeout: timeoutMs,
            killSignal: 'SIGKILL',
          });
          const stop = () => child.kill('SIGTERM');
          const cleanup = () => {
            process.removeListener('SIGINT', stop);
            process.removeListener('SIGTERM', stop);
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
          child.once('error', error => { cleanup(); reject(error); });
          child.once('close', (code, signal) => {
            cleanup();
            resolve({ code: code ?? 1, signal });
          });
        }).catch(async error => {
          await record('cron_failed', safeError(error));
          throw error;
        });
        await record(result.code === 0 ? 'cron_finished' : 'cron_failed', result);
        return result;
      } finally { await output.close(); }
    }, { name: 'cron', timeoutMs: 0 });
  } catch (error) {
    if (error.code === 'ELOCKED') return { code: 0, skipped: 'already_running' };
    throw error;
  }
}

if (isMain(import.meta.url)) {
  process.umask(0o077);
  try {
    const args = process.argv.slice(2);
    if (args.length === 0) process.exitCode = (await runCron()).code;
    else if (args.length !== 1) throw new ConfigurationError('Use --print, --pause or --resume, or no argument to run.');
    else if (args[0] === '--print') process.stdout.write(`${cronLine()}\n`);
    else if (args[0] === '--pause') {
      process.stdout.write('Pausing cron; waiting for any active pass to finish...\n');
      await pauseCron();
      process.stdout.write('Cron paused. No scheduled pass is running.\n');
    } else if (args[0] === '--resume') {
      await resumeCron();
      process.stdout.write('Cron resumed; the next scheduled pass can run.\n');
    } else throw new ConfigurationError('Use --print, --pause or --resume, or no argument to run.');
  } catch (error) {
    reportFailure('cron_failed', error);
    process.exitCode = 1;
  }
}
