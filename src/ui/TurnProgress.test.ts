import { describe, expect, it } from "vitest";

import type { FileChange, PlanItem } from "../contracts/types";

import { shouldShowTurnProgress } from "./turnProgressVisibility";

describe("turn progress", () => {
  it("keeps file review accessible without an active plan", () => {
    expect(shouldShowTurnProgress(null, [changeFixture()])).toBe(true);
    expect(shouldShowTurnProgress(planFixture(), [])).toBe(true);
    expect(shouldShowTurnProgress(null, [])).toBe(false);
  });
});

function changeFixture(): FileChange {
  return {
    path: "src/App.tsx",
    diff: "@@ -1 +1 @@\n-old\n+new",
    kind: { type: "update", movePath: null },
    lineStats: { additions: 1, deletions: 1 },
  };
}

function planFixture(): PlanItem {
  return {
    type: "plan",
    id: "plan-1",
    explanation: null,
    steps: [{ step: "Validar", status: "inProgress" }],
  };
}
