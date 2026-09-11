import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../ui/SettingsDialog.tsx", import.meta.url), "utf8");

describe("settings dialog focus contract", () => {
  it("does not land in search when the dialog mounts", () => {
    expect(source).not.toMatch(/searchInput\?\.focus\(\)/u);
    expect(source).not.toMatch(/queueMicrotask\(\(\) => searchInput/u);
  });

  it("focuses the dialog surface for modal accessibility", () => {
    expect(source).toMatch(/queueMicrotask\(\(\) => dialogElement\?\.focus\(\)\)/u);
    expect(source).toMatch(/tabIndex=\{-1\}/u);
  });
});
