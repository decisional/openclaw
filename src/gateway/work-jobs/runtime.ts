import type { WorkJobRunner } from "./worker.js";
import { WorkJobWorker } from "./worker.js";

let worker: WorkJobWorker | null = null;

/**
 * Return the process-singleton WorkJobWorker, creating and starting it on first access.
 * Stale running jobs from a previous process crash are recovered at start time.
 */
export function getWorkJobWorker(): WorkJobWorker {
  if (!worker) {
    worker = new WorkJobWorker();
    worker.start();
  }
  return worker;
}

export async function stopWorkJobWorker(): Promise<void> {
  if (!worker) {
    return;
  }
  const current = worker;
  worker = null;
  await current.stop();
}

export const __testing = {
  replaceWorkerForTests(runJob: WorkJobRunner): WorkJobWorker {
    if (worker) {
      // Don't start a new worker until the caller finishes cleanup; stop the existing one.
      void worker.stop();
    }
    worker = new WorkJobWorker({
      runJob,
      heartbeatIntervalMs: 100,
      idlePollMs: 25,
      leaseMs: 5_000,
      maxParallel: 2,
    });
    worker.start();
    return worker;
  },
  reset(): void {
    if (worker) {
      void worker.stop();
    }
    worker = null;
  },
};
