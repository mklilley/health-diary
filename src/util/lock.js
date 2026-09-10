import lockfile from 'proper-lockfile';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

export async function withLock(dataDir, work, { name = 'writer', timeoutMs = 600_000 } = {}) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const start = Date.now();
  let release;
  while (!release) {
    try {
      release = await lockfile.lock(join(dataDir, `.${name}`), {
        realpath: false, stale: 120_000, update: 10_000, retries: 0,
        // Continuing after another process owns the lock could corrupt primary records.
        onCompromised() { process.stderr.write('State lock compromised; exiting for safe recovery.\n'); process.exit(1); },
      });
    } catch (error) {
      if (error.code !== 'ELOCKED' || Date.now() - start >= timeoutMs) throw error;
      await setTimeout(100);
    }
  }
  try { return await work(); } finally { await release(); }
}
