import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimNextQueuedJob,
  completeJob,
  ensureJob,
  failJob,
  getJobById,
  getJobByWorkContext,
  heartbeatJob,
  recordFirstSlackPost,
  recoverStaleRunningJobs,
  requeueFailed,
  __testing,
} from "./store.js";

let tempDir: string;

async function freshStore() {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-work-jobs-"));
  __testing.reset({ customPath: path.join(tempDir, "work-jobs.json") });
}

beforeEach(async () => {
  await freshStore();
});

afterEach(async () => {
  await __testing.flushPersistForTests();
  __testing.reset({ customPath: null });
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("work-jobs store", () => {
  it("creates a new queued job for a fresh work_context_id", () => {
    const job = ensureJob({
      workContextId: "ws:a:approval:1",
      inputs: { userMessage: "hello" },
    });
    expect(job.state).toBe("queued");
    expect(job.workContextId).toBe("ws:a:approval:1");
    expect(job.attempts).toBe(0);
    expect(job.jobId).toMatch(/^wj_/);
  });

  it("returns the existing job for a repeated work_context_id without restarting", () => {
    const first = ensureJob({
      workContextId: "ws:a:approval:2",
      inputs: { userMessage: "hi" },
    });
    const second = ensureJob({
      workContextId: "ws:a:approval:2",
      inputs: { userMessage: "ignored" },
    });
    expect(second.jobId).toBe(first.jobId);
    expect(second.inputs.userMessage).toBe("hi"); // unchanged
  });

  it("persists normalized work-job inputs across reload", async () => {
    const created = ensureJob({
      workContextId: "ws:a:approval:normalized-inputs",
      inputs: {
        userMessage: "hi",
        systemPrompt: "system",
        messageChannel: "webchat",
      },
    });
    expect(created.inputs).toMatchObject({
      userMessage: "hi",
      systemPrompt: "system",
      messageChannel: "webchat",
    });

    await __testing.flushPersistForTests();
    const customPath = path.join(tempDir, "work-jobs.json");
    __testing.reset({ customPath });

    const reloaded = getJobByWorkContext("ws:a:approval:normalized-inputs");
    expect(reloaded?.inputs).toMatchObject({
      userMessage: "hi",
      systemPrompt: "system",
      messageChannel: "webchat",
    });
  });

  it("rejects missing user_message", () => {
    expect(() =>
      ensureJob({ workContextId: "ws:a:approval:3", inputs: { userMessage: "" } }),
    ).toThrow(/user_message/);
  });

  it("rejects missing work_context_id", () => {
    expect(() => ensureJob({ workContextId: "", inputs: { userMessage: "hi" } })).toThrow(
      /work_context_id/,
    );
  });

  it("claims queued jobs with lease and advances to running", () => {
    ensureJob({ workContextId: "ws:a:approval:4", inputs: { userMessage: "hi" } });
    const claimed = claimNextQueuedJob({ leaseMs: 5_000 });
    expect(claimed?.state).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.leaseToken).toBeTruthy();
    expect(claimed?.leaseExpiresAt).toBeGreaterThan(Date.now());
  });

  it("returns null when no queued jobs are available", () => {
    expect(claimNextQueuedJob({ leaseMs: 5_000 })).toBeNull();
  });

  it("completes a claimed job with result", () => {
    ensureJob({ workContextId: "ws:a:approval:5", inputs: { userMessage: "hi" } });
    const claimed = claimNextQueuedJob({ leaseMs: 5_000 });
    expect(claimed).not.toBeNull();
    const ok = completeJob({
      jobId: claimed!.jobId,
      leaseToken: claimed!.leaseToken!,
      result: { content: "done" },
    });
    expect(ok).toBe(true);
    const finished = getJobById(claimed!.jobId);
    expect(finished?.state).toBe("completed");
    expect(finished?.result?.content).toBe("done");
  });

  it("rejects complete with a wrong lease token", () => {
    ensureJob({ workContextId: "ws:a:approval:6", inputs: { userMessage: "hi" } });
    const claimed = claimNextQueuedJob({ leaseMs: 5_000 });
    const ok = completeJob({
      jobId: claimed!.jobId,
      leaseToken: "wrong",
      result: { content: "nope" },
    });
    expect(ok).toBe(false);
    expect(getJobById(claimed!.jobId)?.state).toBe("running");
  });

  it("fails a claimed job with error message", () => {
    ensureJob({ workContextId: "ws:a:approval:7", inputs: { userMessage: "hi" } });
    const claimed = claimNextQueuedJob({ leaseMs: 5_000 });
    const ok = failJob({
      jobId: claimed!.jobId,
      leaseToken: claimed!.leaseToken!,
      error: "boom",
    });
    expect(ok).toBe(true);
    const finished = getJobById(claimed!.jobId);
    expect(finished?.state).toBe("failed");
    expect(finished?.error).toBe("boom");
  });

  it("requeueFailed resets a failed job to queued", () => {
    ensureJob({ workContextId: "ws:a:approval:8", inputs: { userMessage: "hi" } });
    const claimed = claimNextQueuedJob({ leaseMs: 5_000 });
    failJob({ jobId: claimed!.jobId, leaseToken: claimed!.leaseToken!, error: "boom" });
    const requeued = requeueFailed("ws:a:approval:8");
    expect(requeued?.state).toBe("queued");
    expect(requeued?.error).toBeUndefined();
  });

  it("requeueFailed is a no-op for running jobs", () => {
    ensureJob({ workContextId: "ws:a:approval:9", inputs: { userMessage: "hi" } });
    claimNextQueuedJob({ leaseMs: 5_000 });
    const requeued = requeueFailed("ws:a:approval:9");
    expect(requeued?.state).toBe("running");
  });

  it("recovers stale running jobs whose lease has expired", () => {
    ensureJob({ workContextId: "ws:a:approval:10", inputs: { userMessage: "hi" } });
    const claimed = claimNextQueuedJob({ leaseMs: 5_000 });
    // Force the lease into the past.
    claimed!.leaseExpiresAt = Date.now() - 1;
    const recovered = recoverStaleRunningJobs();
    expect(recovered).toHaveLength(1);
    expect(getJobById(claimed!.jobId)?.state).toBe("queued");
  });

  it("claimNextQueuedJob recovers stale running jobs inline", () => {
    ensureJob({ workContextId: "ws:a:approval:11", inputs: { userMessage: "hi" } });
    const claimed = claimNextQueuedJob({ leaseMs: 5_000 });
    claimed!.leaseExpiresAt = Date.now() - 1;
    const reclaimed = claimNextQueuedJob({ leaseMs: 5_000 });
    expect(reclaimed?.jobId).toBe(claimed!.jobId);
    expect(reclaimed?.attempts).toBe(2);
  });

  it("heartbeatJob extends the lease only with a valid token", () => {
    ensureJob({ workContextId: "ws:a:approval:12", inputs: { userMessage: "hi" } });
    const claimed = claimNextQueuedJob({ leaseMs: 5_000 });
    const before = claimed!.leaseExpiresAt!;
    const ok = heartbeatJob({
      jobId: claimed!.jobId,
      leaseToken: claimed!.leaseToken!,
      leaseMs: 10_000,
    });
    expect(ok).toBe(true);
    expect(getJobById(claimed!.jobId)?.leaseExpiresAt).toBeGreaterThanOrEqual(before);
    const rejected = heartbeatJob({
      jobId: claimed!.jobId,
      leaseToken: "wrong",
      leaseMs: 10_000,
    });
    expect(rejected).toBe(false);
  });

  it("getJobByWorkContext resolves by canonical id", () => {
    const created = ensureJob({
      workContextId: "ws:a:approval:13",
      inputs: { userMessage: "hi" },
    });
    expect(getJobByWorkContext("ws:a:approval:13")?.jobId).toBe(created.jobId);
    expect(getJobByWorkContext("ws:missing")).toBeNull();
  });

  it("recordFirstSlackPost returns true once and false on duplicate", () => {
    ensureJob({ workContextId: "ws:a:approval:14", inputs: { userMessage: "hi" } });
    expect(recordFirstSlackPost({ workContextId: "ws:a:approval:14" })).toBe(true);
    expect(recordFirstSlackPost({ workContextId: "ws:a:approval:14" })).toBe(false);
  });

  it("persists across reload", async () => {
    const created = ensureJob({
      workContextId: "ws:a:approval:persist",
      inputs: { userMessage: "hi" },
    });
    await __testing.flushPersistForTests();
    const customPath = path.join(tempDir, "work-jobs.json");
    __testing.reset({ customPath });
    const reloaded = getJobByWorkContext("ws:a:approval:persist");
    expect(reloaded?.jobId).toBe(created.jobId);
    expect(reloaded?.state).toBe("queued");
  });
});
