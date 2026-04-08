import { resolveKovaBackend } from "../backends/registry.js";
import type { KovaBackendId, KovaRunTarget } from "../backends/types.js";
import { findMissingKovaQaScenarioIds } from "../catalog/qa.js";
import type { KovaRunArtifact, KovaVerdict } from "../contracts/run-artifact.js";
import { createKovaRunId } from "../lib/run-id.js";
import { renderArtifactSummary } from "../report.js";

function parseRunOptions(args: string[]) {
  const options: {
    target?: KovaRunTarget;
    backend?: KovaBackendId;
    providerMode?: "mock-openai" | "live-frontier";
    scenarioIds: string[];
    json: boolean;
  } = {
    scenarioIds: [],
    json: false,
  };

  const rest = args.filter((arg) => {
    if (arg === "--json") {
      options.json = true;
      return false;
    }
    return true;
  });
  const rawTarget = rest.shift();
  if (rawTarget === "qa") {
    options.target = rawTarget;
  }
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === "--provider-mode") {
      const value = rest.shift();
      if (value === "mock-openai" || value === "live-frontier") {
        options.providerMode = value;
      }
      continue;
    }
    if (arg === "--backend") {
      const value = rest.shift();
      if (value === "host" || value === "multipass") {
        options.backend = value;
      }
      continue;
    }
    if (arg === "--scenario") {
      const value = rest.shift();
      if (value?.trim()) {
        options.scenarioIds.push(value.trim());
      }
    }
  }
  return options;
}

function resolveRunExitCode(artifact: KovaRunArtifact) {
  const exitCodes: Record<KovaVerdict, number> = {
    pass: 0,
    skipped: 0,
    degraded: 2,
    fail: 3,
    flaky: 4,
    blocked: 5,
  };
  return exitCodes[artifact.verdict];
}

export async function runCommand(repoRoot: string, args: string[]) {
  const options = parseRunOptions(args);
  if (options.target !== "qa") {
    throw new Error(`unsupported kova run target: ${String(options.target ?? "")}`);
  }
  if (options.scenarioIds.length > 0) {
    const missingScenarioIds = findMissingKovaQaScenarioIds(options.scenarioIds);
    if (missingScenarioIds.length > 0) {
      throw new Error(`unknown qa scenario id(s): ${missingScenarioIds.join(", ")}`);
    }
  }

  const backend = resolveKovaBackend(options.target, options.backend);
  const artifact = await backend.run({
    repoRoot,
    runId: createKovaRunId(),
    target: options.target,
    backend: options.backend,
    providerMode: options.providerMode,
    scenarioIds: options.scenarioIds.length > 0 ? options.scenarioIds : undefined,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  } else {
    process.stdout.write(renderArtifactSummary(artifact));
  }
  process.exitCode = resolveRunExitCode(artifact);
}
