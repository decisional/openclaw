import { readQaScenarioPack } from "../../../extensions/qa-lab/api.js";
import type { KovaScenarioResult } from "../contracts/run-artifact.js";

export type KovaQaScenarioCatalogEntry = {
  id: string;
  title: string;
  surface: string;
  objective: string;
  sourcePath: string;
  capabilities: string[];
};

export type KovaQaSurfaceSummary = {
  surface: string;
  scenarioCount: number;
};

export function listKovaQaScenarios(): KovaQaScenarioCatalogEntry[] {
  const pack = readQaScenarioPack();
  return pack.scenarios.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    surface: scenario.surface,
    objective: scenario.objective,
    sourcePath: scenario.sourcePath,
    capabilities: buildKovaQaCapabilities(scenario.surface),
  }));
}

export function buildKovaQaCapabilities(surface?: string) {
  const capabilities = new Set<string>(["behavior", "qa"]);
  const normalizedSurface = surface?.trim();
  if (normalizedSurface) {
    capabilities.add(`surface:${normalizedSurface}`);
  }
  return [...capabilities].toSorted();
}

export function findMissingKovaQaScenarioIds(selectedIds: string[]) {
  const knownIds = new Set(listKovaQaScenarios().map((scenario) => scenario.id));
  return selectedIds.filter((scenarioId) => !knownIds.has(scenarioId));
}

export function selectKovaQaScenarios(selectedIds?: string[]) {
  const catalog = listKovaQaScenarios();
  if (!selectedIds || selectedIds.length === 0) {
    return catalog;
  }
  const selectedSet = new Set(selectedIds);
  return catalog.filter((scenario) => selectedSet.has(scenario.id));
}

export function summarizeKovaQaSurfaces(): KovaQaSurfaceSummary[] {
  const counts = new Map<string, number>();
  for (const scenario of listKovaQaScenarios()) {
    counts.set(scenario.surface, (counts.get(scenario.surface) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([surface, scenarioCount]) => ({ surface, scenarioCount }))
    .toSorted((left, right) => left.surface.localeCompare(right.surface));
}

export function buildKovaCoverageFromScenarioResults(scenarioResults: KovaScenarioResult[]) {
  const capabilities = new Set<string>();
  const scenarioIds: string[] = [];
  const surfaces = new Set<string>();
  for (const scenario of scenarioResults) {
    scenarioIds.push(scenario.id);
    for (const capability of scenario.capabilities) {
      capabilities.add(capability);
    }
    if (scenario.surface) {
      surfaces.add(scenario.surface);
    }
  }
  return {
    scenarioIds,
    capabilities: [...capabilities].toSorted(),
    surfaces: [...surfaces].toSorted(),
  };
}

export function buildKovaCoverageFromQaCatalog(selectedIds?: string[]) {
  const scenarios = selectKovaQaScenarios(selectedIds);
  return {
    scenarioIds: scenarios.map((scenario) => scenario.id),
    capabilities: [...new Set(scenarios.flatMap((scenario) => scenario.capabilities))].toSorted(),
    surfaces: [...new Set(scenarios.map((scenario) => scenario.surface))].toSorted(),
  };
}
