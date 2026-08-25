import { describe, expect, it } from "vitest";

import { findViewportVisualAnchorIndex } from "./viewportAnchor";

describe("findViewportVisualAnchorIndex", () => {
  it("anchors the first item whose start is visible before a clipped predecessor", () => {
    const bounds = [
      { bottom: 420, top: -180 },
      { bottom: 720, top: 420 },
      { bottom: 980, top: 720 },
    ];

    expect(
      findViewportVisualAnchorIndex({
        itemCount: bounds.length,
        readItemBounds: (index) => bounds[index] ?? { bottom: 0, top: 0 },
        viewportBottom: 800,
        viewportTop: 0,
      }),
    ).toBe(1);
  });

  it("falls back to the intersecting item when no later start is visible", () => {
    expect(
      findViewportVisualAnchorIndex({
        itemCount: 1,
        readItemBounds: () => ({ bottom: 900, top: -200 }),
        viewportBottom: 800,
        viewportTop: 0,
      }),
    ).toBe(0);
    expect(
      findViewportVisualAnchorIndex({
        itemCount: 1,
        readItemBounds: () => ({ bottom: -1, top: -100 }),
        viewportBottom: 800,
        viewportTop: 0,
      }),
    ).toBeNull();
  });

  it("anchors an unchanged overlapping successor while its predecessor is being measured", () => {
    const bounds = [
      { bottom: 320, top: -201 },
      { bottom: 420, top: -200 },
    ];

    expect(
      findViewportVisualAnchorIndex({
        isAnchorCandidate: (index) => index !== 0,
        itemCount: bounds.length,
        readItemBounds: (index) => bounds[index] ?? { bottom: 0, top: 0 },
        viewportBottom: 640,
        viewportTop: 0,
      }),
    ).toBe(1);
  });
});
