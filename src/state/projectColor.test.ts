import { describe, expect, it } from "vitest";

import {
  hexToHsv,
  hsvToHex,
  hueFromHorizontalPosition,
  normalizeProjectColor,
} from "./projectColor";

describe("project color", () => {
  it("keeps both hue-bar edges valid, red, and spatially distinct", () => {
    expect(hueFromHorizontalPosition(0, 200)).toBe(0);
    expect(hueFromHorizontalPosition(200, 200)).toBe(359);
    expect(hsvToHex(0, 66, 87)).toMatch(/^#[\da-f]{6}$/u);
    expect(hsvToHex(359, 66, 87)).toMatch(/^#[\da-f]{6}$/u);
    expect(hexToHsv(hsvToHex(359, 66, 87)).h).toBeGreaterThanOrEqual(358);
  });

  it("normalizes cyclic hues and clamps percentages without widening hex channels", () => {
    expect(hsvToHex(360, 100, 100)).toBe("#ff0000");
    expect(hsvToHex(-1, 100, 100)).toBe("#ff0004");
    expect(hsvToHex(120, 200, 200)).toBe("#00ff00");
  });

  it("fails closed for malformed persisted project colors", () => {
    expect(normalizeProjectColor("#4ADE80")).toBe("#4ade80");
    expect(() => normalizeProjectColor("#de3ba4b")).toThrow("#RRGGBB");
    expect(() => hexToHsv("green")).toThrow("#RRGGBB");
  });
});
