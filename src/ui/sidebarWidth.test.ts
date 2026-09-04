import { describe, expect, it } from "vitest";

import { PROFILE_STORAGE_KEYS } from "../state/profileStorage";
import {
  readSidebarWidth,
  resolveSidebarWidthMetrics,
  SIDEBAR_WIDTH_DEFAULT_PX,
  sidebarWidthFromPointer,
  writeSidebarWidth,
} from "./sidebarWidth";

function createStorage(initial: string | null = null) {
  const values = new Map<string, string>();
  if (initial !== null) {
    values.set(PROFILE_STORAGE_KEYS.sidebarWidth, initial);
  }
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
}

describe("sidebar width", () => {
  it("uses a wider default while preserving the main panel minimum", () => {
    const metrics = resolveSidebarWidthMetrics(SIDEBAR_WIDTH_DEFAULT_PX, 1_008);

    expect(metrics.width).toBe(SIDEBAR_WIDTH_DEFAULT_PX);
    expect(metrics.minimumWidth).toBe(240);
    expect(metrics.maximumWidth).toBe(520);
  });

  it("limits the sidebar to the available width of the main panel", () => {
    const metrics = resolveSidebarWidthMetrics(520, 800);

    expect(metrics.maximumWidth).toBe(362);
    expect(metrics.width).toBe(362);
  });

  it("clamps pointer movement to the supported range", () => {
    expect(sidebarWidthFromPointer(524, 200, 1_008)).toBe(320);
    expect(sidebarWidthFromPointer(200, 200, 1_008)).toBe(240);
    expect(sidebarWidthFromPointer(1_000, 200, 1_008)).toBe(520);
  });

  it("persists valid widths and recovers safely from corrupted values", () => {
    const storage = createStorage();
    writeSidebarWidth(384, storage);
    expect(readSidebarWidth(storage)).toBe(384);

    const corrupted = createStorage("not-a-number");
    expect(readSidebarWidth(corrupted)).toBe(SIDEBAR_WIDTH_DEFAULT_PX);
    expect(readSidebarWidth(createStorage("  "))).toBe(SIDEBAR_WIDTH_DEFAULT_PX);
  });
});
