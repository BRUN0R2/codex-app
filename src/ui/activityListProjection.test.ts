import { describe, expect, it } from "vitest";
import {
  activityListEntryDisclosureKey,
  activityListEntryReuseGroup,
  COLLAPSED_ACTIVITY_ITEM_ESTIMATE_PX,
  COLLAPSED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX,
  createActivityListProjection,
  EXPANDED_DIFF_ACTIVITY_CHROME_HEIGHT_PX,
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
    expect(projection.estimatedOffsetOf(projection.count)).toBe(2_700_000);
    expect(pathReads).toBe(0);
    expect(projection.entryAt(0).kind).toBe("fileChange");
    expect(pathReads).toBe(1);
    const lastEntry = projection.entryAt(99_999);
    expect(pathReads).toBe(2);
    projection.entryAt(99_743);
    expect(pathReads).toBe(3);
    projection.entryAt(65_536);
    expect(pathReads).toBe(4);
    projection.entryAt(0);
    expect(pathReads).toBe(4);
    expect(projection.indexOf(lastEntry.key)).toBe(99_999);
    expect(pathReads).toBe(4);
    expect(projection.kindAt(0)).toBe("fileChange");
    expect(projection.fileChangeAt(0, projection.keyAt(0))).toBe(change);
    expect(() => projection.fileChangeAt(0, lastEntry.key)).toThrow("lost its position");
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
    if (
      firstActivity === undefined ||
      firstChange === undefined ||
      firstChange.kind !== "fileChange"
    ) {
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
      EXPANDED_DIFF_ACTIVITY_CHROME_HEIGHT_PX + 40,
    );
    expect(
      estimateActivityListEntrySize(
        {
          ...firstChange,
          change: {
            ...firstChange.change,
            diff: "-first\n-second\n+replacement",
          },
        },
        true,
        "split",
      ),
    ).toBe(EXPANDED_DIFF_ACTIVITY_CHROME_HEIGHT_PX + 40);
    expect(activityListEntryReuseGroup(firstActivity)).toBe("commandExecution");
    expect(activityListEntryReuseGroup(firstChange)).toBe("fileChange");
    expect(activityListEntryDisclosureKey(firstChange)).toBe(firstChange.key);
    expect(createActivityListProjection([command, changes]).itemAt(0)).toBe(command);
  });

  it("separates tool rows whose expanded structures are incompatible", () => {
    const sourceTool = {
      type: "toolExecution",
      id: "source-tool",
      name: "read_file",
      description: "Leu src/example.ts",
      status: "completed",
      outputPresentation: { type: "sourceFile", path: "src/example.ts" },
      output: {
        id: "source-output",
        preview: "1: const first = 1;\n2: const second = 2;",
        byteLength: 42,
        nextCursor: null,
      },
    } as const satisfies AgentActivityItem;
    const searchTool = {
      type: "toolExecution",
      id: "search-tool",
      name: "search_text",
      description: "Search src/example.ts",
      status: "completed",
      outputPresentation: { type: "searchResults" },
      output: {
        id: "search-output",
        preview: "src/example.ts:1:const first = 1;",
        byteLength: 33,
        nextCursor: null,
      },
    } as const satisfies AgentActivityItem;
    const projection = createActivityListProjection([sourceTool, searchTool]);

    expect(projection.reuseGroupAt(0)).toBe("toolExecution:sourceFile");
    expect(projection.reuseGroupAt(1)).toBe("toolExecution:searchResults");
    expect(activityListEntryReuseGroup(projection.entryAt(0))).not.toBe(
      activityListEntryReuseGroup(projection.entryAt(1)),
    );
    expect(estimateActivityListEntrySize(projection.entryAt(0), true)).toBe(126);
    expect(estimateActivityListEntrySize(projection.entryAt(1), true)).toBe(104);
  });
});
