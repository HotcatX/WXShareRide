import type { Config } from './config.ts';
import type { Pool } from 'pg';
import { closeDueRides } from './rides/completion.ts';
import { createCollectorTransport, deliverBusinessEvents } from './analytics/delivery.ts';

type RideJobs = {
  closeRides: () => Promise<unknown>;
  deliverEvents: () => Promise<unknown>;
};
type JobFailure = 'RIDE_CLOSURE_FAILED' | 'EVENT_DELIVERY_FAILED';

export function startConfiguredRideJobs(config: Config, pool: Pool, report: (code: JobFailure) => void) {
  if (config.businessMode !== 'active') return async () => {};
  // Never accept business writes in the executable without a delivery path.
  // The same deployment state controls HTTP writes and both background loops.
  if (!config.collector) throw new Error('Active backend requires collector configuration');
  const send = createCollectorTransport(config.collector);
  return startRideJobs({ closeRides: () => closeDueRides(pool, config.appId),
    deliverEvents: () => deliverBusinessEvents(pool, config.appId, send) }, report);
}

/** Start only after the business writer has been activated. This module does
 * not decide cutover authority. Each task runs independently, never overlaps
 * itself, and drains before the caller closes the database pool. */
export function startRideJobs(jobs: RideJobs, report: (code: JobFailure) => void) {
  let stopping = false;
  const running = new Set<Promise<void>>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function schedule(run: () => Promise<unknown>, code: JobFailure, interval: number, failures = 0, delay = 0) {
    if (stopping) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopping) return;
      const work = (async () => {
        let nextFailures = 0;
        try { await run(); }
        catch {
          nextFailures = Math.min(failures + 1, 6);
          // Diagnostics cannot stop the other job or turn into an unhandled
          // rejection. Never pass payloads, provider errors or credentials.
          try { report(code); } catch { /* The next scheduled run still retries. */ }
        }
        const nextDelay = nextFailures ? Math.min(300_000, interval * 2 ** (nextFailures - 1)) : interval;
        schedule(run, code, interval, nextFailures, nextDelay);
      })();
      running.add(work);
      void work.finally(() => { running.delete(work); });
    }, delay);
    timer.unref();
    timers.add(timer);
  }

  schedule(jobs.closeRides, 'RIDE_CLOSURE_FAILED', 60_000);
  schedule(jobs.deliverEvents, 'EVENT_DELIVERY_FAILED', 10_000);
  return async function stop() {
    stopping = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    await Promise.all(running);
  };
}
