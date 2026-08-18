import { describe, expect, it } from "vitest";

import type { Automation, AutomationRun } from "../contracts/types";
import {
  removeAutomationRuns,
  replaceAutomations,
  unreadAutomationRuns,
  upsertAutomation,
  upsertAutomationRun,
} from "./automations";

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "automation-1",
    name: "Revisar",
    prompt: "Revise o projeto.",
    projectPath: "C:\\workspace",
    enabled: true,
    intervalMinutes: 60,
    timezone: "America/Sao_Paulo",
    timezoneOffsetMin: 180,
    nextRunAt: 2_000,
    lastRunAt: null,
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function run(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "run-1",
    automationId: "automation-1",
    trigger: "scheduled",
    status: "completed",
    threadId: "thread-1",
    turnId: "turn-1",
    error: null,
    reviewed: false,
    createdAt: 1_000,
    startedAt: 1_001,
    completedAt: 1_100,
    ...overrides,
  };
}

describe("estado de Automações", () => {
  it("mantém a versão mais nova quando comando e notificação chegam fora de ordem", () => {
    const newer = automation({ version: 2, updatedAt: 2_000, name: "Nova" });
    const result = upsertAutomation([newer], automation({ version: 1, updatedAt: 3_000 }));
    expect(result).toEqual([newer]);
  });

  it("deduplica snapshots e ordena ativas antes das pausadas", () => {
    const result = replaceAutomations([
      automation({ id: "paused", enabled: false, nextRunAt: null }),
      automation({ id: "active", name: "Ativa", nextRunAt: 1_500 }),
      automation({ id: "active", name: "Atualizada", version: 2, updatedAt: 2_000 }),
    ]);
    expect(result.map((entry) => entry.id)).toEqual(["active", "paused"]);
    expect(result[0]?.name).toBe("Atualizada");
  });

  it("substitui o mesmo run e expõe somente resultados terminais não revisados", () => {
    const running = run({
      status: "running",
      completedAt: null,
      reviewed: false,
    });
    const completed = run();
    const runs = upsertAutomationRun([running], completed);
    expect(runs).toHaveLength(1);
    expect(unreadAutomationRuns(runs)).toEqual([completed]);
  });

  it("não regride o ciclo de vida nem perde a revisão com eventos atrasados", () => {
    const reviewed = run({ reviewed: true });
    const staleRunning = run({
      status: "running",
      completedAt: null,
      reviewed: false,
    });
    expect(upsertAutomationRun([reviewed], staleRunning)).toEqual([reviewed]);
  });

  it("remove o histórico junto com uma definição excluída", () => {
    expect(
      removeAutomationRuns([run(), run({ id: "other", automationId: "other" })], "automation-1"),
    ).toEqual([run({ id: "other", automationId: "other" })]);
  });
});
