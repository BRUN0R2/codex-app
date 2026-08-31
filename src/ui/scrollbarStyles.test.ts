import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");

describe("timeline output scrollbar styles", () => {
  it("keeps command output on the full native scrollbar contract", () => {
    const compactStart = styles.indexOf(":where(");
    const compactEnd = styles.indexOf("code,\npre", compactStart);
    expect(compactStart).toBeGreaterThan(-1);
    expect(compactEnd).toBeGreaterThan(compactStart);
    expect(styles.slice(compactStart, compactEnd)).not.toContain(".command-card-scroll");
    expect(styles).toMatch(/::-webkit-scrollbar\s*\{\s*width:\s*14px;\s*height:\s*14px;/u);
    expect(styles).toMatch(
      /::-webkit-scrollbar-button:vertical:single-button\s*\{[\s\S]*?display:\s*block;/u,
    );
  });
});
