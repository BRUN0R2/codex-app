import { describe, expect, it } from "vitest";

import { monospaceColumnCount } from "./monospace";

describe("monospaceColumnCount", () => {
  it("advances tabs to the next four-column boundary", () => {
    expect(monospaceColumnCount("a\tb")).toBe(5);
  });
});
