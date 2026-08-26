import { describe, expect, it } from "vitest";

import {
  browserViewportPreset,
  initialBrowserViewport,
  parseBrowserViewport,
  STANDARD_BROWSER_VIEWPORTS,
} from "./browserViewport";

describe("browser responsive viewport", () => {
  it("accepts every standard resolution from 720p through 8K", () => {
    for (const preset of STANDARD_BROWSER_VIEWPORTS) {
      expect(parseBrowserViewport(String(preset.width), String(preset.height), 1)).toEqual({
        ok: true,
        viewport: { width: preset.width, height: preset.height, scale: 1 },
      });
      expect(browserViewportPreset(preset.id)).toBe(preset);
    }
  });

  it("rejects fractional, out-of-range, and unsupported values", () => {
    expect(parseBrowserViewport("319", "720", 1)).toMatchObject({ ok: false });
    expect(parseBrowserViewport("1280.5", "720", 1)).toMatchObject({ ok: false });
    expect(parseBrowserViewport("1280", "4321", 1)).toMatchObject({ ok: false });
    expect(parseBrowserViewport("1280", "720", 0.42)).toMatchObject({ ok: false });
  });

  it("derives a bounded initial viewport from the live browser surface", () => {
    expect(initialBrowserViewport(280.4, 160.2)).toEqual({
      width: 320,
      height: 240,
      scale: 1,
    });
    expect(initialBrowserViewport(8_200, 5_000)).toEqual({
      width: 7_680,
      height: 4_320,
      scale: 1,
    });
  });
});
