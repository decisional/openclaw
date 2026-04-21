import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimNextQueuedJob,
  ensureJob,
  getJobById,
  __testing as storeTesting,
} from "./store.js";
import type { WorkJobResult } from "./types.js";
import { WorkJobWorker } from "./worker.js";

let tempDir: string;

async function freshStore() {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-work-jobs-worker-"));
  storeTesting.reset({ customPath: path.join(tempDir, "work-jobs.json") });
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timed out waiting for predicate"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

beforeEach(async () => {
  await freshStore();
});

afterEach(async () => {
  await storeTesting.flushPersistForTests();
  storeTesting.reset({ customPath: null });
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("WorkJobWorker", () => {
  it("runs a queued job to completion with the provided runner", async () => {
    const worker = new WorkJobWorker({
      runJob: async (job) => ({
        content: `echo:${job.inputs.userMessage}`,
      }),
      leaseMs: 5_000,
      heartbeatIntervalMs: 100,
      idlePollMs: 10,
      maxParallel: 1,
    });
    worker.start();
    try {
      const job = ensureJob({
        workContextId: "ws:a:1",
        inputs: { userMessage: "hello" },
      });
      worker.notify();
      await waitFor(() => getJobById(job.jobId)?.state === "completed");
      const finished = getJobById(job.jobId);
      expect(finished?.state).toBe("completed");
      expect(finished?.result?.content).toBe("echo:hello");
      expect(finished?.completedAt).toBeDefined();
    } finally {
      await worker.stop();
    }
  });

  it("fails a job when the runner throws and preserves the error message", async () => {
    const worker = new WorkJobWorker({
      runJob: async () => {
        throw new Error("boom");
      },
      leaseMs: 5_000,
      heartbeatIntervalMs: 100,
      idlePollMs: 10,
      maxParallel: 1,
    });
    worker.start();
    try {
      const job = ensureJob({
        workContextId: "ws:a:2",
        inputs: { userMessage: "hello" },
      });
      worker.notify();
      await waitFor(() => getJobById(job.jobId)?.state === "failed");
      const finished = getJobById(job.jobId);
      expect(finished?.state).toBe("failed");
      expect(finished?.error).toBe("boom");
    } finally {
      await worker.stop();
    }
  });

  it("serializes work within maxParallel", async () => {
    const inFlight: number[] = [];
    let current = 0;
    const worker = new WorkJobWorker({
      runJob: async (): Promise<WorkJobResult> => {
        current += 1;
        inFlight.push(current);
        await new Promise((r) => setTimeout(r, 50));
        current -= 1;
        return { content: "ok" };
      },
      leaseMs: 5_000,
      heartbeatIntervalMs: 100,
      idlePollMs: 5,
      maxParallel: 2,
    });
    worker.start();
    try {
      for (let i = 0; i < 5; i += 1) {
        ensureJob({
          workContextId: `ws:parallel:${i}`,
          inputs: { userMessage: `msg ${i}` },
        });
      }
      worker.notify();
      await waitFor(
        () => storeTesting.list().every((j) => j.state === "completed"),
        5_000,
      );
      expect(Math.max(...inFlight)).toBeLessThanOrEqual(2);
      expect(storeTesting.list()).toHaveLength(5);
    } finally {
      await worker.stop();
    }
  });

  it("does not re-run completed jobs when notify is called again", async () => {
    let runs = 0;
    const worker = new WorkJobWorker({
      runJob: async () => {
        runs += 1;
        return { content: "ok" };
      },
      leaseMs: 5_000,
      heartbeatIntervalMs: 100,
      idlePollMs: 10,
      maxParallel: 1,
    });
    worker.start();
    try {
      ensureJob({ workContextId: "ws:once", inputs: { userMessage: "hi" } });
      worker.notify();
      await waitFor(() => storeTesting.list().every((j) => j.state === "completed"));
      // Spurious notify, nothing to claim.
      worker.notify();
      await new Promise((r) => setTimeout(r, 50));
      expect(runs).toBe(1);
      expect(claimNextQueuedJob({ leaseMs: 5_000 })).toBeNull();
    } finally {
      await worker.stop();
    }
  });
});
