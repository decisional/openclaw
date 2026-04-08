import { z } from "zod";

export const kovaVerdictSchema = z.enum([
  "pass",
  "fail",
  "flaky",
  "blocked",
  "degraded",
  "skipped",
]);

export const kovaClassificationDomainSchema = z.enum([
  "product",
  "environment",
  "backend",
  "scenario",
  "unknown",
]);

export const kovaScenarioResultSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  verdict: kovaVerdictSchema,
  details: z.string().trim().min(1).optional(),
  stepCounts: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
});

export const kovaRunArtifactSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().trim().min(1),
  selection: z.object({
    command: z.string().trim().min(1),
    target: z.string().trim().min(1),
    suite: z.string().trim().min(1).optional(),
  }),
  scenario: z.object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    category: z.string().trim().min(1),
    capabilities: z.array(z.string().trim().min(1)).default([]),
  }),
  backend: z.object({
    kind: z.string().trim().min(1),
    mode: z.string().trim().min(1).optional(),
  }),
  environment: z.object({
    os: z.string().trim().min(1),
    arch: z.string().trim().min(1),
    nodeVersion: z.string().trim().min(1),
    gitCommit: z.string().trim().min(1).optional(),
    gitDirty: z.boolean(),
  }),
  status: z.enum(["completed", "aborted", "timed_out", "infra_failed"]),
  verdict: kovaVerdictSchema,
  classification: z.object({
    domain: kovaClassificationDomainSchema,
    reason: z.string().trim().min(1),
  }),
  timing: z.object({
    startedAt: z.string().trim().min(1),
    finishedAt: z.string().trim().min(1),
    durationMs: z.number().int().nonnegative(),
  }),
  counts: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  scenarioResults: z.array(kovaScenarioResultSchema).default([]),
  evidence: z.object({
    reportPath: z.string().trim().min(1).optional(),
    summaryPath: z.string().trim().min(1).optional(),
    sourceArtifactPaths: z.array(z.string().trim().min(1)).default([]),
  }),
  notes: z.array(z.string().trim().min(1)).default([]),
});

export type KovaRunArtifact = z.infer<typeof kovaRunArtifactSchema>;
export type KovaScenarioResult = z.infer<typeof kovaScenarioResultSchema>;
export type KovaVerdict = z.infer<typeof kovaVerdictSchema>;
