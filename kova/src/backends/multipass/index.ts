import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  buildKovaCoverageFromQaCatalog,
  buildKovaCoverageFromScenarioResults,
} from "../../catalog/qa.js";
import type { KovaRunArtifact } from "../../contracts/run-artifact.js";
import { kovaRunArtifactSchema } from "../../contracts/run-artifact.js";
import { ensureDir, resolveKovaRunDir, writeJsonFile, writeTextFile } from "../../lib/fs.js";
import { resolveGitCommit, resolveGitDirty } from "../../lib/git.js";
import { updateKovaRunIndex } from "../../lib/run-index.js";
import type { KovaBackend, KovaBackendRunSelection } from "../types.js";
import { buildMultipassPlan, renderGuestRunScript } from "./plan.js";
import {
  buildQaScenarioResultsFromSummary,
  deriveQaClassification,
  deriveQaVerdict,
  readQaSummary,
} from "./qa-summary.js";
import {
  appendMultipassLog,
  resolveMultipassAvailability,
  runMultipassCommand,
} from "./runtime.js";

function createMultipassBaseArtifact(params: {
  selection: KovaBackendRunSelection;
  providerMode: "mock-openai" | "live-frontier";
  gitCommit?: string;
  gitDirty: boolean;
}): Pick<
  KovaRunArtifact,
  "schemaVersion" | "runId" | "selection" | "scenario" | "backend" | "environment"
> {
  return {
    schemaVersion: 1,
    runId: params.selection.runId,
    selection: {
      command: "run",
      target: params.selection.target,
      suite: "qa-suite",
      scenarioIds:
        params.selection.scenarioIds && params.selection.scenarioIds.length > 0
          ? params.selection.scenarioIds
          : undefined,
    },
    scenario: {
      id: params.selection.target,
      title: "QA suite",
      category: "behavior",
      capabilities: ["behavior", "qa"],
    },
    backend: {
      id: "multipass",
      title: "Multipass VM",
      kind: "multipass",
      runner: "vm",
      mode: params.providerMode,
      binary: "multipass",
    },
    environment: {
      os: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      gitCommit: params.gitCommit,
      gitDirty: params.gitDirty,
    },
    coverage: buildKovaCoverageFromQaCatalog(params.selection.scenarioIds),
  };
}

export const multipassBackend: KovaBackend = {
  id: "multipass",
  title: "Multipass VM",
  supportsTarget(target): target is "qa" {
    return target === "qa";
  },
  async run(selection) {
    const startedAt = new Date();
    const runDir = resolveKovaRunDir(selection.repoRoot, selection.runId);
    await ensureDir(runDir);

    const hostLogPath = path.join(runDir, "multipass-host.log");
    const hostGuestScriptPath = path.join(runDir, "multipass-guest-run.sh");
    const plan = buildMultipassPlan(selection, hostGuestScriptPath);
    const planPath = path.join(runDir, "multipass-plan.json");
    await writeTextFile(hostGuestScriptPath, renderGuestRunScript(plan));
    await writeJsonFile(planPath, plan);
    await writeTextFile(hostLogPath, `# Kova Multipass host log\nrunId=${selection.runId}\n\n`);

    const providerMode = selection.providerMode ?? "mock-openai";
    const [gitCommit, gitDirty] = await Promise.all([
      resolveGitCommit(selection.repoRoot),
      resolveGitDirty(selection.repoRoot),
    ]);
    const baseArtifact = createMultipassBaseArtifact({
      selection,
      providerMode,
      gitCommit,
      gitDirty,
    });
    const evidencePaths = [
      runDir,
      planPath,
      hostGuestScriptPath,
      hostLogPath,
      path.join(runDir, "run.json"),
    ];

    const availability = await resolveMultipassAvailability();
    if (!availability.available || !availability.binaryPath) {
      const finishedAt = new Date();
      const artifact = kovaRunArtifactSchema.parse({
        ...baseArtifact,
        status: "infra_failed",
        verdict: "blocked",
        classification: {
          domain: "backend",
          reason: `multipass CLI not found on host; generated plan artifacts in ${runDir}`,
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
          sourceArtifactPaths: evidencePaths,
        },
        notes: [
          "backend=multipass",
          "state=missing-cli",
          `vmName=${plan.vmName}`,
          `guestMountedRepoPath=${plan.guestMountedRepoPath}`,
          `guestRepoPath=${plan.guestRepoPath}`,
          `guestScriptPath=${plan.guestScriptPath}`,
          "availability=missing",
        ],
      });
      await writeJsonFile(path.join(runDir, "run.json"), artifact);
      await updateKovaRunIndex(selection.repoRoot, artifact);
      return artifact;
    }

    let launched = false;
    try {
      await runMultipassCommand({
        binaryPath: availability.binaryPath,
        logPath: hostLogPath,
        args: ["launch", "--name", plan.vmName, plan.image],
      });
      launched = true;
      await runMultipassCommand({
        binaryPath: availability.binaryPath,
        logPath: hostLogPath,
        args: ["mount", selection.repoRoot, `${plan.vmName}:${plan.guestMountedRepoPath}`],
      });
      await runMultipassCommand({
        binaryPath: availability.binaryPath,
        logPath: hostLogPath,
        args: ["transfer", hostGuestScriptPath, `${plan.vmName}:${plan.guestScriptPath}`],
      });
      await runMultipassCommand({
        binaryPath: availability.binaryPath,
        logPath: hostLogPath,
        args: ["exec", plan.vmName, "--", "chmod", "+x", plan.guestScriptPath],
      });
      await runMultipassCommand({
        binaryPath: availability.binaryPath,
        logPath: hostLogPath,
        args: ["exec", plan.vmName, "--", plan.guestScriptPath],
      });

      const reportPath = path.join(runDir, "qa", "qa-suite-report.md");
      const { summaryPath, summary } = await readQaSummary(runDir);
      const reportExists = await readFile(reportPath, "utf8")
        .then(() => true)
        .catch(() => false);
      if (!reportExists) {
        throw new Error(`expected QA report at ${reportPath} after Multipass run`);
      }

      const scenarioResults = buildQaScenarioResultsFromSummary({
        selectedScenarioIds: selection.scenarioIds,
        summary,
      });
      const finishedAt = new Date();
      const artifact = kovaRunArtifactSchema.parse({
        ...baseArtifact,
        status: "completed",
        verdict: deriveQaVerdict(summary.counts.failed),
        classification: deriveQaClassification(summary.counts.failed),
        timing: {
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
        },
        counts: summary.counts,
        coverage: buildKovaCoverageFromScenarioResults(scenarioResults),
        scenarioResults,
        evidence: {
          reportPath,
          summaryPath,
          sourceArtifactPaths: [...evidencePaths, path.join(runDir, "qa"), reportPath, summaryPath],
        },
        notes: [
          "backend=multipass",
          "state=executed",
          `vmName=${plan.vmName}`,
          `guestMountedRepoPath=${plan.guestMountedRepoPath}`,
          `guestRepoPath=${plan.guestRepoPath}`,
          `guestScriptPath=${plan.guestScriptPath}`,
          `availability=${availability.binaryPath}`,
        ],
      });
      await writeJsonFile(path.join(runDir, "run.json"), artifact);
      await updateKovaRunIndex(selection.repoRoot, artifact);
      return artifact;
    } catch (error) {
      await appendMultipassLog(
        hostLogPath,
        `ERROR: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      const finishedAt = new Date();
      const artifact = kovaRunArtifactSchema.parse({
        ...baseArtifact,
        status: "infra_failed",
        verdict: "blocked",
        classification: {
          domain: "backend",
          reason: error instanceof Error ? error.message : String(error),
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
          sourceArtifactPaths: evidencePaths,
        },
        notes: [
          "backend=multipass",
          `state=${launched ? "exec-failed" : "launch-failed"}`,
          `vmName=${plan.vmName}`,
          `guestMountedRepoPath=${plan.guestMountedRepoPath}`,
          `guestRepoPath=${plan.guestRepoPath}`,
          `guestScriptPath=${plan.guestScriptPath}`,
          `availability=${availability.binaryPath}`,
        ],
      });
      await writeJsonFile(path.join(runDir, "run.json"), artifact);
      await updateKovaRunIndex(selection.repoRoot, artifact);
      return artifact;
    } finally {
      if (launched) {
        await runMultipassCommand({
          binaryPath: availability.binaryPath,
          logPath: hostLogPath,
          args: ["delete", "--purge", plan.vmName],
        }).catch(async (error) => {
          await appendMultipassLog(
            hostLogPath,
            `CLEANUP ERROR: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        });
      }
    }
  },
};
