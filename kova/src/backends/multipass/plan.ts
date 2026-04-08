import path from "node:path";
import type { KovaBackendRunSelection } from "../types.js";

export type KovaMultipassPlan = {
  version: 1;
  runId: string;
  vmName: string;
  image: string;
  hostRepoPath: string;
  hostGuestScriptPath: string;
  guestMountedRepoPath: string;
  guestRepoPath: string;
  guestArtifactsPath: string;
  guestScriptPath: string;
  providerMode: "mock-openai" | "live-frontier";
  scenarioIds: string[];
  hostCommands: string[];
  qaCommand: string[];
};

const MULTIPASS_MOUNTED_REPO_PATH = "/workspace/openclaw-host";
const MULTIPASS_IMAGE = "lts";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function buildVmName(runId: string) {
  const suffix = runId
    .replace(/^kova_/, "")
    .replaceAll(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase();
  return `kova-${suffix}`.slice(0, 48);
}

function buildQaCommand(selection: KovaBackendRunSelection, guestArtifactsPath: string) {
  const command = [
    "pnpm",
    "openclaw",
    "qa",
    "suite",
    "--output-dir",
    guestArtifactsPath,
    "--provider-mode",
    selection.providerMode ?? "mock-openai",
  ];
  for (const scenarioId of selection.scenarioIds ?? []) {
    command.push("--scenario", scenarioId);
  }
  return command;
}

function buildGuestRepoPath(vmName: string) {
  return `/home/ubuntu/${vmName}/repo`;
}

export function renderGuestRunScript(plan: KovaMultipassPlan) {
  const lines = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    'command -v node >/dev/null || { echo "missing node in guest" >&2; exit 1; }',
    'command -v pnpm >/dev/null || { echo "missing pnpm in guest" >&2; exit 1; }',
    'command -v rsync >/dev/null || { echo "missing rsync in guest" >&2; exit 1; }',
    "",
    `mkdir -p ${shellQuote(path.posix.dirname(plan.guestRepoPath))}`,
    `rm -rf ${shellQuote(plan.guestRepoPath)}`,
    `mkdir -p ${shellQuote(plan.guestRepoPath)}`,
    `mkdir -p ${shellQuote(path.posix.dirname(plan.guestArtifactsPath))}`,
    [
      "rsync -a --delete",
      "--exclude",
      shellQuote(".git"),
      "--exclude",
      shellQuote("node_modules"),
      "--exclude",
      shellQuote(".artifacts"),
      shellQuote(`${plan.guestMountedRepoPath}/`),
      shellQuote(`${plan.guestRepoPath}/`),
    ].join(" "),
    `cd ${shellQuote(plan.guestRepoPath)}`,
    "pnpm install --frozen-lockfile",
    plan.qaCommand.map(shellQuote).join(" "),
    "",
  ];
  return lines.join("\n");
}

export function buildMultipassPlan(
  selection: KovaBackendRunSelection,
  hostGuestScriptPath: string,
): KovaMultipassPlan {
  const vmName = buildVmName(selection.runId);
  const guestRepoPath = buildGuestRepoPath(vmName);
  const guestArtifactsPath = `${MULTIPASS_MOUNTED_REPO_PATH}/.artifacts/kova/runs/${selection.runId}/qa`;
  const guestScriptPath = `/tmp/${vmName}-qa-suite.sh`;
  const qaCommand = buildQaCommand(selection, guestArtifactsPath);
  return {
    version: 1,
    runId: selection.runId,
    vmName,
    image: MULTIPASS_IMAGE,
    hostRepoPath: selection.repoRoot,
    hostGuestScriptPath,
    guestMountedRepoPath: MULTIPASS_MOUNTED_REPO_PATH,
    guestRepoPath,
    guestArtifactsPath,
    guestScriptPath,
    providerMode: selection.providerMode ?? "mock-openai",
    scenarioIds: selection.scenarioIds ?? [],
    hostCommands: [
      `multipass launch --name ${shellQuote(vmName)} ${shellQuote(MULTIPASS_IMAGE)}`,
      `multipass mount ${shellQuote(selection.repoRoot)} ${shellQuote(`${vmName}:${MULTIPASS_MOUNTED_REPO_PATH}`)}`,
      `multipass transfer ${shellQuote(hostGuestScriptPath)} ${shellQuote(`${vmName}:${guestScriptPath}`)}`,
      `multipass exec ${shellQuote(vmName)} -- chmod +x ${shellQuote(guestScriptPath)}`,
      `multipass exec ${shellQuote(vmName)} -- ${shellQuote(guestScriptPath)}`,
      `multipass delete --purge ${shellQuote(vmName)}`,
    ],
    qaCommand,
  };
}
