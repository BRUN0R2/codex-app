import type { Automation, AutomationRun } from "../contracts/types";

export const MAX_VISIBLE_AUTOMATION_RUNS = 200;

export function upsertAutomation(
  current: readonly Automation[],
  incoming: Automation,
): readonly Automation[] {
  const existing = current.find((automation) => automation.id === incoming.id);
  if (
    existing !== undefined &&
    (existing.version > incoming.version ||
      (existing.version === incoming.version && existing.updatedAt > incoming.updatedAt))
  ) {
    return current;
  }
  return sortAutomations([
    ...current.filter((automation) => automation.id !== incoming.id),
    incoming,
  ]);
}

export function replaceAutomations(incoming: readonly Automation[]): readonly Automation[] {
  const byId = new Map<string, Automation>();
  for (const automation of incoming) {
    const existing = byId.get(automation.id);
    if (
      existing === undefined ||
      automation.version > existing.version ||
      (automation.version === existing.version && automation.updatedAt >= existing.updatedAt)
    ) {
      byId.set(automation.id, automation);
    }
  }
  return sortAutomations([...byId.values()]);
}

export function removeAutomation(
  current: readonly Automation[],
  automationId: string,
): readonly Automation[] {
  return current.filter((automation) => automation.id !== automationId);
}

export function upsertAutomationRun(
  current: readonly AutomationRun[],
  incoming: AutomationRun,
): readonly AutomationRun[] {
  const existing = current.find((run) => run.id === incoming.id);
  const merged = existing === undefined ? incoming : mergeAutomationRun(existing, incoming);
  return sortAutomationRuns([...current.filter((run) => run.id !== incoming.id), merged]).slice(
    0,
    MAX_VISIBLE_AUTOMATION_RUNS,
  );
}

export function replaceAutomationRuns(
  incoming: readonly AutomationRun[],
): readonly AutomationRun[] {
  const byId = new Map<string, AutomationRun>();
  for (const run of incoming) {
    const existing = byId.get(run.id);
    byId.set(run.id, existing === undefined ? run : mergeAutomationRun(existing, run));
  }
  return sortAutomationRuns([...byId.values()]).slice(0, MAX_VISIBLE_AUTOMATION_RUNS);
}

export function removeAutomationRuns(
  current: readonly AutomationRun[],
  automationId: string,
): readonly AutomationRun[] {
  return current.filter((run) => run.automationId !== automationId);
}

export function unreadAutomationRuns(runs: readonly AutomationRun[]): readonly AutomationRun[] {
  return runs.filter(
    (run) =>
      !run.reviewed &&
      (run.status === "completed" || run.status === "failed" || run.status === "interrupted"),
  );
}

function sortAutomations(automations: Automation[]): readonly Automation[] {
  return automations.sort((left, right) => {
    if (left.enabled !== right.enabled) {
      return left.enabled ? -1 : 1;
    }
    const leftNext = left.nextRunAt ?? Number.MAX_SAFE_INTEGER;
    const rightNext = right.nextRunAt ?? Number.MAX_SAFE_INTEGER;
    return (
      leftNext - rightNext ||
      left.name.localeCompare(right.name, "pt-BR", { sensitivity: "base" }) ||
      left.id.localeCompare(right.id)
    );
  });
}

function sortAutomationRuns(runs: AutomationRun[]): readonly AutomationRun[] {
  return runs.sort(
    (left, right) =>
      (right.completedAt ?? right.startedAt ?? right.createdAt) -
        (left.completedAt ?? left.startedAt ?? left.createdAt) || right.id.localeCompare(left.id),
  );
}

function mergeAutomationRun(existing: AutomationRun, incoming: AutomationRun): AutomationRun {
  const existingRank = automationRunStatusRank(existing);
  const incomingRank = automationRunStatusRank(incoming);
  const lifecycle =
    incomingRank > existingRank ||
    (incomingRank === existingRank &&
      (incoming.completedAt ?? incoming.startedAt ?? incoming.createdAt) >=
        (existing.completedAt ?? existing.startedAt ?? existing.createdAt))
      ? incoming
      : existing;
  return lifecycle.reviewed || (!existing.reviewed && !incoming.reviewed)
    ? lifecycle
    : { ...lifecycle, reviewed: true };
}

function automationRunStatusRank(run: AutomationRun): number {
  switch (run.status) {
    case "queued":
      return 0;
    case "running":
      return 1;
    case "completed":
    case "failed":
    case "interrupted":
      return 2;
  }
}
