import { type Accessor, batch, createMemo, createSignal } from "solid-js";

import type {
  Automation,
  AutomationInput,
  AutomationListResponse,
  AutomationRun,
} from "../contracts/types";
import { formatMessage, type TranslationMessages } from "../i18n/messages";
import {
  confirmDesktopDialog as confirm,
  createAutomation as createAutomationCommand,
  deleteAutomation as deleteAutomationCommand,
  listAutomations,
  markAutomationRunReviewed as markAutomationRunReviewedCommand,
  runAutomationNow as runAutomationNowCommand,
  updateAutomation as updateAutomationCommand,
} from "../infrastructure/codexClient";
import {
  unreadAutomationRuns as readUnreadAutomationRuns,
  removeAutomation,
  removeAutomationRuns,
  replaceAutomationRuns,
  replaceAutomations,
  upsertAutomation,
  upsertAutomationRun,
} from "./automations";
import type { SessionControllerHost } from "./controllerSupport";
import { uiError } from "./uiError";

export interface AutomationSessionController {
  readonly automations: Accessor<readonly Automation[]>;
  readonly automationRuns: Accessor<readonly AutomationRun[]>;
  readonly automationsLoading: Accessor<boolean>;
  readonly unreadAutomationRuns: Accessor<readonly AutomationRun[]>;
  readonly applyChanged: (automation: Automation) => void;
  readonly applyDeleted: (automationId: string) => void;
  readonly applyRunUpdated: (run: AutomationRun) => void;
  readonly clearSession: () => void;
  readonly createAutomation: (input: AutomationInput) => Promise<boolean>;
  readonly deleteAutomation: (automationId: string) => Promise<boolean>;
  readonly loadSession: (snapshot: AutomationListResponse) => void;
  readonly markAutomationRunReviewed: (runId: string) => Promise<boolean>;
  readonly mergeRuns: (runs: readonly AutomationRun[]) => void;
  readonly refreshAutomations: () => Promise<boolean>;
  readonly runAutomationNow: (automationId: string) => Promise<boolean>;
  readonly setLoading: (loading: boolean) => void;
  readonly updateAutomation: (
    automationId: string,
    expectedVersion: number,
    input: AutomationInput,
  ) => Promise<boolean>;
}

export interface AutomationSessionDependencies {
  readonly confirmations: Accessor<TranslationMessages["confirmations"]>;
  readonly host: SessionControllerHost;
  readonly isSignedIn: () => boolean;
}

export function createAutomationSessionController(
  dependencies: AutomationSessionDependencies,
): AutomationSessionController {
  const { confirmations, host, isSignedIn } = dependencies;
  const [automations, setAutomations] = createSignal<readonly Automation[]>([]);
  const [automationRuns, setAutomationRuns] = createSignal<readonly AutomationRun[]>([]);
  const [automationsLoading, setAutomationsLoading] = createSignal(false);
  const unreadAutomationRuns = createMemo(() => readUnreadAutomationRuns(automationRuns()));

  function clearSession(): void {
    batch(() => {
      setAutomations([]);
      setAutomationRuns([]);
      setAutomationsLoading(false);
    });
  }

  function loadSession(snapshot: AutomationListResponse): void {
    setAutomations(replaceAutomations(snapshot.data));
    setAutomationRuns(replaceAutomationRuns(snapshot.runs));
  }

  function mergeRuns(runs: readonly AutomationRun[]): void {
    setAutomationRuns((current) => replaceAutomationRuns([...runs, ...current]));
  }

  function setLoading(loading: boolean): void {
    setAutomationsLoading(loading);
  }

  function applyChanged(automation: Automation): void {
    if (isSignedIn()) {
      setAutomations((current) => upsertAutomation(current, automation));
    }
  }

  function applyDeleted(automationId: string): void {
    if (!isSignedIn()) {
      return;
    }
    batch(() => {
      setAutomations((current) => removeAutomation(current, automationId));
      setAutomationRuns((current) => removeAutomationRuns(current, automationId));
    });
  }

  function applyRunUpdated(run: AutomationRun): void {
    if (isSignedIn()) {
      setAutomationRuns((current) => upsertAutomationRun(current, run));
    }
  }

  async function refreshAutomations(): Promise<boolean> {
    if (!isSignedIn() || automationsLoading()) {
      return false;
    }
    setAutomationsLoading(true);
    try {
      const snapshot = await host.withPending(() => listAutomations());
      batch(() => {
        setAutomations(replaceAutomations(snapshot.data));
        setAutomationRuns((current) => replaceAutomationRuns([...snapshot.runs, ...current]));
      });
      return true;
    } catch (reason) {
      host.reportError(reason);
      return false;
    } finally {
      setAutomationsLoading(false);
    }
  }

  async function createAutomation(input: AutomationInput): Promise<boolean> {
    try {
      const created = await host.withPending(() => createAutomationCommand(input));
      setAutomations((current) => upsertAutomation(current, created));
      return true;
    } catch (reason) {
      host.reportError(reason);
      return false;
    }
  }

  async function updateAutomation(
    automationId: string,
    expectedVersion: number,
    input: AutomationInput,
  ): Promise<boolean> {
    try {
      const updated = await host.withPending(() =>
        updateAutomationCommand(automationId, expectedVersion, input),
      );
      setAutomations((current) => upsertAutomation(current, updated));
      return true;
    } catch (reason) {
      host.reportError(reason);
      return false;
    }
  }

  function deleteAutomation(automationId: string): Promise<boolean> {
    return host.singleFlight.run(`automation:delete:${automationId}`, () =>
      deleteAutomationOnce(automationId),
    );
  }

  async function deleteAutomationOnce(automationId: string): Promise<boolean> {
    const automation = automations().find((entry) => entry.id === automationId);
    if (automation === undefined) {
      host.setError(uiError("automationUnavailable"));
      return false;
    }
    const hasActiveRun = automationRuns().some(
      (run) =>
        run.automationId === automationId && (run.status === "queued" || run.status === "running"),
    );
    if (hasActiveRun) {
      host.setError(uiError("automationActiveRun"));
      return false;
    }
    try {
      const confirmed = await confirm(
        formatMessage(confirmations().deleteAutomationDescription, {
          name: automation.name,
        }),
        {
          cancelLabel: confirmations().cancel,
          kind: "warning",
          okLabel: confirmations().delete,
          title: confirmations().deleteAutomationTitle,
        },
      );
      if (!confirmed) {
        return false;
      }
      await host.withPending(() => deleteAutomationCommand(automationId));
      batch(() => {
        setAutomations((current) => removeAutomation(current, automationId));
        setAutomationRuns((current) => removeAutomationRuns(current, automationId));
      });
      return true;
    } catch (reason) {
      host.reportError(reason);
      return false;
    }
  }

  function runAutomationNow(automationId: string): Promise<boolean> {
    return host.singleFlight.run(`automation:run:${automationId}`, () =>
      runAutomationNowOnce(automationId),
    );
  }

  async function runAutomationNowOnce(automationId: string): Promise<boolean> {
    try {
      const run = await host.withPending(() => runAutomationNowCommand(automationId));
      setAutomationRuns((current) => upsertAutomationRun(current, run));
      return true;
    } catch (reason) {
      host.reportError(reason);
      return false;
    }
  }

  function markAutomationRunReviewed(runId: string): Promise<boolean> {
    return host.singleFlight.run(`automation:review:${runId}`, () =>
      markAutomationRunReviewedOnce(runId),
    );
  }

  async function markAutomationRunReviewedOnce(runId: string): Promise<boolean> {
    try {
      await host.withPending(() => markAutomationRunReviewedCommand(runId));
      const run = automationRuns().find((entry) => entry.id === runId);
      if (run !== undefined) {
        setAutomationRuns((current) => upsertAutomationRun(current, { ...run, reviewed: true }));
      }
      return true;
    } catch (reason) {
      host.reportError(reason);
      return false;
    }
  }

  return {
    automations,
    automationRuns,
    automationsLoading,
    unreadAutomationRuns,
    applyChanged,
    applyDeleted,
    applyRunUpdated,
    clearSession,
    createAutomation,
    deleteAutomation,
    loadSession,
    markAutomationRunReviewed,
    mergeRuns,
    refreshAutomations,
    runAutomationNow,
    setLoading,
    updateAutomation,
  };
}
