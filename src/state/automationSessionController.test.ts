import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Automation, AutomationListResponse, AutomationRun } from "../contracts/types";
import { createAutomationSessionController } from "./automationSessionController";
import { SingleFlightOperations } from "./singleFlightOperations";

vi.mock("../infrastructure/codexClient", () => ({
  confirmDesktopDialog: vi.fn(async () => true),
  createAutomation: vi.fn(),
  deleteAutomation: vi.fn(async () => undefined),
  listAutomations: vi.fn(),
  markAutomationRunReviewed: vi.fn(async () => undefined),
  runAutomationNow: vi.fn(),
  updateAutomation: vi.fn(),
}));

const client = await import("../infrastructure/codexClient");

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: "automation-1",
    name: "Review",
    prompt: "Review the project.",
    projectPath: "C:\\workspace",
    enabled: true,
    intervalMinutes: 60,
    timezone: "UTC",
    timezoneOffsetMin: 0,
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
    startedAt: 1_000,
    completedAt: 2_000,
    createdAt: 1_000,
    ...overrides,
  };
}

function createController(options: { signedIn?: boolean } = {}) {
  const reportError = vi.fn();
  const setError = vi.fn();
  const confirmations = {
    cancel: "Cancel",
    delete: "Delete",
    deleteAutomationDescription: "Delete {name}?",
    deleteAutomationTitle: "Delete automation",
    deleteTaskTitle: "Delete task?",
    deleteActiveTaskDescription: "Delete active {name}?",
    deleteTaskDescription: "Delete {name}?",
    newTask: "New task",
  } as const;
  return createRoot((dispose) => {
    const controller = createAutomationSessionController({
      confirmations: () => confirmations,
      host: {
        isDisposed: () => false,
        reportError,
        setError,
        singleFlight: new SingleFlightOperations<string, boolean>(),
        withPending: async (operation) => operation(),
      },
      isSignedIn: () => options.signedIn ?? true,
    });
    return { controller, dispose, reportError, setError };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("automation session controller", () => {
  it("replaces the authenticated catalog and unread projection", () => {
    const { controller, dispose } = createController();
    const snapshot: AutomationListResponse = {
      data: [automation()],
      runs: [run({ reviewed: false })],
    };
    controller.loadSession(snapshot);
    expect(controller.automations()).toEqual(snapshot.data);
    expect(controller.automationRuns()).toEqual(snapshot.runs);
    expect(controller.unreadAutomationRuns()).toHaveLength(1);
    dispose();
  });

  it("clears the signed-out session without residual loading state", () => {
    const { controller, dispose } = createController();
    controller.setLoading(true);
    controller.loadSession({ data: [automation()], runs: [run()] });
    controller.clearSession();
    expect(controller.automations()).toEqual([]);
    expect(controller.automationRuns()).toEqual([]);
    expect(controller.automationsLoading()).toBe(false);
    dispose();
  });

  it("ignores notification mutations while signed out", () => {
    const { controller, dispose } = createController({ signedIn: false });
    controller.applyChanged(automation());
    controller.applyRunUpdated(run());
    controller.applyDeleted("automation-1");
    expect(controller.automations()).toEqual([]);
    expect(controller.automationRuns()).toEqual([]);
    dispose();
  });

  it("refuses deletion while a run is active", async () => {
    const { controller, dispose, setError } = createController();
    controller.loadSession({
      data: [automation()],
      runs: [run({ status: "running" })],
    });
    await expect(controller.deleteAutomation("automation-1")).resolves.toBe(false);
    expect(setError).toHaveBeenCalledWith(
      "Wait for the active run to finish before deleting this automation.",
    );
    expect(client.deleteAutomation).not.toHaveBeenCalled();
    dispose();
  });

  it("deletes after confirmation and removes owned runs", async () => {
    const { controller, dispose } = createController();
    controller.loadSession({
      data: [automation()],
      runs: [run({ status: "completed" })],
    });
    await expect(controller.deleteAutomation("automation-1")).resolves.toBe(true);
    expect(client.deleteAutomation).toHaveBeenCalledWith("automation-1");
    expect(controller.automations()).toEqual([]);
    expect(controller.automationRuns()).toEqual([]);
    dispose();
  });
});
