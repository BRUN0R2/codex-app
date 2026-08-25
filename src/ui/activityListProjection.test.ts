import { describe, expect, it } from "vitest";
import {
  activityListEntryDisclosureKey,
  activityListEntryReuseGroup,
  COLLAPSED_ACTIVITY_ITEM_ESTIMATE_PX,
  COLLAPSED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX,
  createActivityListProjection,
  EXPANDED_DIFF_ACTIVITY_ITEM_ESTIMATE_PX,
  EXPANDED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX,
  estimateActivityListEntrySize,
  projectActivityListEntries,
} from "./activityListProjection";
import type { AgentActivityItem } from "./agentActivityPresentation";

describe("activity list projection", () => {
  it("constructs an indexed one-hundred-thousand-file projection without reading file paths", () => {
    let pathReads = 0;
    const change = {
      get path() {
        pathReads += 1;
        return "src/shared.ts";
      },
      kind: { type: "update" as const, movePath: null },
      diff: "-old\n+new",
      lineStats: { additions: 1, deletions: 1 },
    };
    const item = {
      type: "fileChange",
      id: "massive-change-set",
      status: "completed",
      changes: Array.from({ length: 100_000 }, () => change),
    } as const satisfies AgentActivityItem;

    const projection = createActivityListProjection([item]);

    expect(projection.count).toBe(100_000);
    expect(projection.estimatedOffsetOf(projection.count)).toBe(2_600_000);
    expect(pathReads).toBe(0);
    expect(projection.entryAt(0).kind).toBe("fileChange");
    expect(pathReads).toBe(1);
  });

  it("flattens every changed file into the virtualized activity sequence", () => {
    const item = {
      type: "fileChange",
      id: "change-set",
      status: "completed",
      changes: Array.from({ length: 1_000 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        kind: { type: "update" as const, movePath: null },
        diff: `-old ${index}\n+new ${index}`,
        lineStats: { additions: 1, deletions: 1 },
      })),
    } as const satisfies AgentActivityItem;

    const entries = projectActivityListEntries([item]);

    expect(entries).toHaveLength(1_000);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(1_000);
    expect(entries[500]?.kind).toBe("fileChange");
  });

  it("keeps repeated paths distinct and preserves surrounding activity order", () => {
    const command = {
      type: "commandExecution",
      id: "command",
      command: "pnpm test",
      cwd: ".",
      processId: null,
      startedAt: null,
      source: "agent",
      status: "completed",
      aggregatedOutput: null,
      liveOutput: null,
      exitCode: 0,
      durationMs: 1,
    } as const satisfies AgentActivityItem;
    const changes = {
      type: "fileChange",
      id: "changes",
      status: "completed",
      changes: [0, 1].map((index) => ({
        path: "src/repeated.ts",
        kind: { type: "update" as const, movePath: null },
        diff: `-${index}\n+${index + 1}`,
        lineStats: null,
      })),
    } as const satisfies AgentActivityItem;

    const entries = projectActivityListEntries([command, changes]);
    const firstActivity = entries[0];
    const firstChange = entries[1];
    if (firstActivity === undefined || firstChange === undefined) {
      throw new Error("The projected activity sequence is incomplete.");
    }

    expect(entries.map((entry) => entry.kind)).toEqual(["item", "fileChange", "fileChange"]);
    expect(entries[1]?.key).not.toBe(entries[2]?.key);
    expect(estimateActivityListEntrySize(firstActivity, false)).toBe(
      COLLAPSED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX,
    );
    expect(estimateActivityListEntrySize(firstActivity, true)).toBe(
      EXPANDED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX,
    );
    expect(estimateActivityListEntrySize(firstChange, false)).toBe(
      COLLAPSED_ACTIVITY_ITEM_ESTIMATE_PX,
    );
    expect(estimateActivityListEntrySize(firstChange, true)).toBe(
      EXPANDED_DIFF_ACTIVITY_ITEM_ESTIMATE_PX,
    );
    expect(activityListEntryReuseGroup(firstActivity)).toBe("commandExecution");
    expect(activityListEntryReuseGroup(firstChange)).toBe("fileChange");
    expect(activityListEntryDisclosureKey(firstChange)).toBe(firstChange.key);
  });
});
