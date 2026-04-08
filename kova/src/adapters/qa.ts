import path from "node:path";
import { readQaBootstrapScenarioCatalog, runQaSuite } from "../../../extensions/qa-lab/api.js";
import {
  buildKovaCoverageFromQaCatalog,
  buildKovaCoverageFromScenarioResults,
  buildKovaQaCapabilities,
} from "../catalog/qa.js";
import {
  kovaRunArtifactSchema,
  type KovaRunArtifact,
  type KovaScenarioResult,
} from "../contracts/run-artifact.js";
import { ensureDir, resolveKovaRunDir, writeJsonFile } from "../lib/fs.js";
import { resolveGitCommit, resolveGitDirty } from "../lib/git.js";
import { updateKovaRunIndex } from "../lib/run-index.js";

export type KovaQaRunOptions = {
  repoRoot: string;
  runId: string;
  providerMode?: "mock-openai" | "live-frontier";
  scenarioIds?: string[];
};

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function deriveVerdict(failedCount: number) {
  return failedCount > 0 ? "fail" : "pass";
}

function deriveClassification(failedCount: number) {
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

function buildQaScenarioResults(params: {
  selectedScenarioIds?: string[];
  qaResult: Awaited<ReturnType<typeof runQaSuite>>;
}) {
  const catalog = readQaBootstrapScenarioCatalog();
  const selectedScenarios =
    params.selectedScenarioIds && params.selectedScenarioIds.length > 0
      ? catalog.scenarios.filter((scenario) => params.selectedScenarioIds?.includes(scenario.id))
      : catalog.scenarios;

  return params.qaResult.scenarios.map((scenario, index) => {
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

export async function runQaAdapter(opts: KovaQaRunOptions) {
  const startedAt = new Date();
  const runDir = resolveKovaRunDir(opts.repoRoot, opts.runId);
  const qaOutputDir = path.join(runDir, "qa");
  await ensureDir(qaOutputDir);
  const baseArtifact = {
    schemaVersion: 1 as const,
    runId: opts.runId,
    selection: {
      command: "run",
      target: "qa",
      suite: "qa-suite",
      scenarioIds: opts.scenarioIds && opts.scenarioIds.length > 0 ? opts.scenarioIds : undefined,
    },
    scenario: {
      id: "qa",
      title: "QA suite",
      category: "behavior",
      capabilities: ["behavior", "qa"],
    },
    backend: {
      id: "host",
      title: "Host runtime",
      kind: "host",
      runner: "host",
      mode: opts.providerMode ?? "mock-openai",
    },
    environment: {
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      gitCommit: await resolveGitCommit(opts.repoRoot),
      gitDirty: await resolveGitDirty(opts.repoRoot),
    },
    coverage: buildKovaCoverageFromQaCatalog(opts.scenarioIds),
  };

  try {
    const qaResult = await runQaSuite({
      repoRoot: opts.repoRoot,
      outputDir: qaOutputDir,
      providerMode: opts.providerMode ?? "mock-openai",
      scenarioIds: opts.scenarioIds,
    });
    const finishedAt = new Date();
    const counts = {
      total: qaResult.scenarios.length,
      passed: qaResult.scenarios.filter((scenario) => scenario.status === "pass").length,
      failed: qaResult.scenarios.filter((scenario) => scenario.status === "fail").length,
    };
    const scenarioResults = buildQaScenarioResults({
      selectedScenarioIds: opts.scenarioIds,
      qaResult,
    });

    const artifact = kovaRunArtifactSchema.parse({
      ...baseArtifact,
      status: "completed",
      verdict: deriveVerdict(counts.failed),
      classification: deriveClassification(counts.failed),
      timing: {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      },
      counts,
      coverage: buildKovaCoverageFromScenarioResults(scenarioResults),
      scenarioResults,
      evidence: {
        reportPath: qaResult.reportPath,
        summaryPath: qaResult.summaryPath,
        sourceArtifactPaths: [qaResult.outputDir, qaResult.reportPath, qaResult.summaryPath],
      },
      notes: [
        `watchUrl=${qaResult.watchUrl}`,
        `providerMode=${opts.providerMode ?? "mock-openai"}`,
      ],
    } satisfies KovaRunArtifact);

    await writeJsonFile(path.join(runDir, "run.json"), artifact);
    await writeJsonFile(path.join(runDir, "qa-result.json"), qaResult);
    await updateKovaRunIndex(opts.repoRoot, artifact);
    return artifact;
  } catch (error) {
    const finishedAt = new Date();
    const artifact = kovaRunArtifactSchema.parse({
      ...baseArtifact,
      status: "infra_failed",
      verdict: "blocked",
      classification: {
        domain: "backend" as const,
        reason: describeError(error),
      },
      timing: {
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      },
      counts: {
        total: 0,
        passed: 0,
        failed: 0,
      },
      coverage: baseArtifact.coverage,
      scenarioResults: [],
      evidence: {
        sourceArtifactPaths: [qaOutputDir],
      },
      notes: [`providerMode=${opts.providerMode ?? "mock-openai"}`],
    } satisfies KovaRunArtifact);
    await writeJsonFile(path.join(runDir, "run.json"), artifact);
    await updateKovaRunIndex(opts.repoRoot, artifact);
    throw error;
  }
}
