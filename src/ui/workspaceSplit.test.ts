import { describe, expect, it } from "vitest";

import { PROFILE_STORAGE_KEYS } from "../state/profileStorage";
import {
  readWorkspaceSplitRatio,
  resolveWorkspaceSplitMetrics,
  WORKSPACE_SPLIT_DEFAULT_RATIO,
  workspaceSplitRatioFromPointer,
  writeWorkspaceSplitRatio,
} from "./workspaceSplit";

function createStorage(initial: string | null = null) {
  const values = new Map<string, string>();
  if (initial !== null) {
    values.set(PROFILE_STORAGE_KEYS.workspaceSplitRatio, initial);
  }
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
}

describe("workspace split", () => {
  it("starts with two equal panes after reserving the divider", () => {
    const metrics = resolveWorkspaceSplitMetrics(WORKSPACE_SPLIT_DEFAULT_RATIO, 1_008);

    expect(metrics.chatPaneWidth).toBe(500);
    expect(metrics.workspacePaneWidth).toBe(500);
    expect(metrics.ratio).toBe(0.5);
  });

  it("clamps both panes to their usable minimum while dragging", () => {
    const left = resolveWorkspaceSplitMetrics(0.05, 1_008);
    const right = resolveWorkspaceSplitMetrics(0.95, 1_008);

    expect(left.ratio).toBe(0.42);
    expect(left.chatPaneWidth).toBe(420);
    expect(right.ratio).toBeCloseTo(0.58);
    expect(right.workspacePaneWidth).toBeCloseTo(420);
  });

  it("falls back to an equal split when the container cannot fit both minimums", () => {
    const metrics = resolveWorkspaceSplitMetrics(0.8, 520);

    expect(metrics.minimumRatio).toBe(0.5);
    expect(metrics.maximumRatio).toBe(0.5);
    expect(metrics.ratio).toBe(0.5);
  });

  it("maps the divider center to a bounded ratio", () => {
    expect(workspaceSplitRatioFromPointer(704, 200, 1_008)).toBe(0.5);
    expect(workspaceSplitRatioFromPointer(210, 200, 1_008)).toBe(0.42);
    expect(workspaceSplitRatioFromPointer(1_198, 200, 1_008)).toBeCloseTo(0.58);
  });

  it("persists valid ratios and recovers safely from corrupted values", () => {
    const storage = createStorage();
    writeWorkspaceSplitRatio(0.63, storage);
    expect(readWorkspaceSplitRatio(storage)).toBe(0.63);

    const corrupted = createStorage("not-a-number");
    expect(readWorkspaceSplitRatio(corrupted)).toBe(WORKSPACE_SPLIT_DEFAULT_RATIO);
    expect(readWorkspaceSplitRatio(createStorage("  "))).toBe(WORKSPACE_SPLIT_DEFAULT_RATIO);
  });
});
