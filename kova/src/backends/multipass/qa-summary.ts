import path from "node:path";
import { z } from "zod";
import { buildKovaQaCapabilities, selectKovaQaScenarios } from "../../catalog/qa.js";
import type { KovaScenarioResult } from "../../contracts/run-artifact.js";
import { readJsonFile } from "../../lib/fs.js";

const qaSummaryScenarioStepSchema = z.object({
  name: z.string().trim().min(1),
  status: z.enum(["pass", "fail"]),
  details: z.string().trim().min(1).optional(),
});

const qaSummaryScenarioSchema = z.object({
  name: z.string().trim().min(1),
  status: z.enum(["pass", "fail"]),
  details: z.string().trim().min(1).optional(),
  steps: z.array(qaSummaryScenarioStepSchema),
});

const qaSummarySchema = z.object({
  scenarios: z.array(qaSummaryScenarioSchema),
  counts: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
});

export type KovaQaSummary = z.infer<typeof qaSummarySchema>;

export function deriveQaVerdict(failedCount: number) {
  return failedCount > 0 ? "fail" : "pass";
}

export function deriveQaClassification(failedCount: number) {
  return failedCount > 0
    ? {
        domain: "product" as const,
        reason: "one or more QA scenarios failed",
      }
    : {
        domain: "product" as const,
        reason: "all QA scenarios passed under current selection",
      };
}

export function buildQaScenarioResultsFromSummary(params: {
  selectedScenarioIds?: string[];
  summary: KovaQaSummary;
}) {
  const selectedScenarios = selectKovaQaScenarios(params.selectedScenarioIds);

  return params.summary.scenarios.map((scenario, index) => {
    const catalogScenario = selectedScenarios[index];
    const passedSteps = scenario.steps.filter((step) => step.status === "pass").length;
    const failedSteps = scenario.steps.filter((step) => step.status === "fail").length;
    return {
      id: catalogScenario?.id ?? scenario.name,
      title: catalogScenario?.title ?? scenario.name,
      verdict: scenario.status,
      capabilities: buildKovaQaCapabilities(catalogScenario?.surface),
      surface: catalogScenario?.surface,
      sourcePath: catalogScenario?.sourcePath,
      details: scenario.details,
      stepCounts: {
        total: scenario.steps.length,
        passed: passedSteps,
        failed: failedSteps,
      },
    } satisfies KovaScenarioResult;
  });
}

export async function readQaSummary(runDir: string) {
  const summaryPath = path.join(runDir, "qa", "qa-suite-summary.json");
  const summary = qaSummarySchema.parse(await readJsonFile(summaryPath));
  return {
    summaryPath,
    summary,
  };
}
