import { createMemo, createSignal, type Accessor } from "solid-js";

import { isJsonObject, readString, type JsonObject } from "../../shared/codex/types";
import { summarizeUnifiedDiff, type DiffSummary } from "./diffParser";

type TurnPlanStepStatus = "completed" | "inProgress" | "pending";

interface TurnPlanStep {
  step: string;
  status: TurnPlanStepStatus;
}

export interface TurnProgressSummary {
  additions: number;
  currentStep: number | null;
  deletions: number;
  fileCount: number;
  totalSteps: number;
}

export interface TurnProgressController {
  summary: Accessor<TurnProgressSummary | null>;
  reset: () => void;
  updateDiff: (params: JsonObject | undefined) => void;
  updatePlan: (params: JsonObject | undefined) => void;
}

export function createTurnProgress(): TurnProgressController {
  const [plan, setPlan] = createSignal<TurnPlanStep[]>([]);
  const [diff, setDiff] = createSignal<DiffSummary>(emptyDiffSummary());
  const summary = createMemo<TurnProgressSummary | null>(() => {
    const steps = plan();
    const diffSummary = diff();
    if (steps.length === 0 && diffSummary.fileCount === 0) {
      return null;
    }
    const activeIndex = steps.findIndex(({ status }) => status === "inProgress");
    const completedCount = steps.filter(({ status }) => status === "completed").length;
    const currentStep =
      steps.length === 0
        ? null
        : activeIndex >= 0
          ? activeIndex + 1
          : Math.min(completedCount + 1, steps.length);
    return {
      additions: diffSummary.additions,
      currentStep,
      deletions: diffSummary.deletions,
      fileCount: diffSummary.fileCount,
      totalSteps: steps.length,
    };
  });

  function reset() {
    setPlan([]);
    setDiff(emptyDiffSummary());
  }

  function updateDiff(params: JsonObject | undefined) {
    const value = readString(params, "diff");
    if (value !== undefined) {
      setDiff(summarizeUnifiedDiff(value));
    }
  }

  function updatePlan(params: JsonObject | undefined) {
    if (!Array.isArray(params?.plan)) {
      return;
    }
    const steps = params.plan.flatMap((value) => {
      if (!isJsonObject(value)) {
        return [];
      }
      const step = readString(value, "step");
      const status = readPlanStatus(value.status);
      return step === undefined || status === null ? [] : [{ step, status }];
    });
    setPlan(steps);
  }

  return { summary, reset, updateDiff, updatePlan };
}

function readPlanStatus(value: unknown): TurnPlanStepStatus | null {
  return value === "completed" || value === "inProgress" || value === "pending"
    ? value
    : null;
}

function emptyDiffSummary(): DiffSummary {
  return { additions: 0, deletions: 0, fileCount: 0 };
}
