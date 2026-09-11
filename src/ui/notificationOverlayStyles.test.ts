import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles/notification-overlay.css", import.meta.url), "utf8");

describe("notification overlay styles", () => {
  it("sizes the overlay from content instead of stretching cards to the window", () => {
    const surfaceRule = ruleBody(/\.notification-overlay-surface\s*\{([\s\S]*?)\}/u);
    expect(surfaceRule).toContain("display: block");
    expect(surfaceRule).not.toContain("min-height");
    expect(surfaceRule).not.toContain("align-items: stretch");
  });

  it("uses an opaque card surface so background content cannot bleed through", () => {
    const cardRule = ruleBody(/\.notification-card\s*\{([\s\S]*?)\}/u);
    expect(cardRule).toContain("background: var(--color-background-surface, #181818)");
    expect(cardRule).not.toMatch(/background:\s*[^;]*transparent/u);
    expect(cardRule).not.toContain("backdrop-filter");
  });
});

function ruleBody(pattern: RegExp): string {
  const body = styles.match(pattern)?.[1];
  if (body === undefined) throw new Error(`Missing notification style rule ${pattern.source}.`);
  return body;
}
