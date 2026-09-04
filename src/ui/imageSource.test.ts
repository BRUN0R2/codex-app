import { describe, expect, it } from "vitest";

import { isDirectImageSource, resolveImageSource } from "./imageSource";

describe("imageSource", () => {
  it("accepts only inert inline image sources", () => {
    expect(isDirectImageSource("https://images.example.com/result.png")).toBe(false);
    expect(isDirectImageSource("data:image/png;base64,aGVsbG8=")).toBe(true);
    expect(isDirectImageSource("blob:https://example.com/identifier")).toBe(true);
    expect(isDirectImageSource("data:image/svg+xml,<svg/>")).toBe(false);
    expect(isDirectImageSource("javascript:alert(1)")).toBe(false);
    expect(isDirectImageSource("data:text/html,unsafe")).toBe(false);
  });

  it("rejects remote Markdown images before attempting attachment resolution", async () => {
    await expect(resolveImageSource("https://attacker.example/private.png")).rejects.toThrow(
      "Remote Markdown images are not loaded automatically.",
    );
    await expect(resolveImageSource("http://attacker.example/private.png")).rejects.toThrow(
      "Remote Markdown images are not loaded automatically.",
    );
  });
});
