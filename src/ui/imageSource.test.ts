import { describe, expect, it } from "vitest";

import { isDirectImageSource } from "./imageSource";

describe("imageSource", () => {
  it("accepts only browser-safe direct image sources", () => {
    expect(isDirectImageSource("https://images.example.com/result.png")).toBe(true);
    expect(isDirectImageSource("data:image/png;base64,aGVsbG8=")).toBe(true);
    expect(isDirectImageSource("blob:https://example.com/identifier")).toBe(true);
    expect(isDirectImageSource("javascript:alert(1)")).toBe(false);
    expect(isDirectImageSource("data:text/html,unsafe")).toBe(false);
  });
});
