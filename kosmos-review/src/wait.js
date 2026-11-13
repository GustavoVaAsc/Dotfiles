// Blocks until a submitted round newer than the ones that existed at the start appears. It watches the files of
// the review folder, never the server, so it keeps working if the server idles out or is stopped meanwhile.
import { watch as fsWatch } from 'node:fs';
import path from 'node:path';
import { listRoundNumbers } from './store.js';

/**
 * @returns {Promise<{status:'round', round:number, file:string} | {status:'timeout'} | {status:'aborted'}>}
 * Wakes on fs.watch events and also polls every `pollMs`, so a watcher that is unavailable, errors or misses an
 * event only costs latency. Between wake-ups it sleeps: it never spins.
 */
export async function waitForRound({ reviewDir, timeoutMs, pollMs = 2000, watch = fsWatch, signal, onCheck = () => {}, after }) {
  // `after` (a round number) makes a round that already exists count: the first one greater than it is delivered.
  // Without it only rounds newer than the newest existing one count. Either way one round at a time, lowest first.
  const baseline = after ?? (await listRoundNumbers(reviewDir)).at(-1) ?? 0;
  const deadline = Date.now() + timeoutMs;

  let wake = null;
  let watcher = null;
  try {
    watcher = watch(reviewDir, () => wake?.());
    watcher?.on?.('error', () => {}); // polling continues
  } catch {
    watcher = null; // no inotify (limit reached, unsupported fs): polling only
  }

  try {
    for (;;) {
      const next = (await listRoundNumbers(reviewDir)).find((n) => n > baseline);
      onCheck();
      if (next !== undefined) return { status: 'round', round: next, file: path.join(reviewDir, `round-${next}.json`) };
      if (signal?.aborted) return { status: 'aborted' };
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: 'timeout' };
      await new Promise((resolve) => {
        const timer = setTimeout(done, Math.min(pollMs, remaining));
        function done() {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          wake = null;
          resolve();
        }
        wake = done;
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  } finally {
    try { watcher?.close?.(); } catch { /* already closed */ }
  }
}
