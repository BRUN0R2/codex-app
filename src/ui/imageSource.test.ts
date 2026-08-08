import { describe, expect, it } from "vitest";

import { extractToolImageSource, isDirectImageSource } from "./imageSource";

describe("imageSource", () => {
  it("accepts only browser-safe direct image sources", () => {
    expect(isDirectImageSource("https://images.example.com/result.png")).toBe(true);
    expect(isDirectImageSource("data:image/png;base64,aGVsbG8=")).toBe(true);
    expect(isDirectImageSource("blob:https://example.com/identifier")).toBe(true);
    expect(isDirectImageSource("javascript:alert(1)")).toBe(false);
    expect(isDirectImageSource("data:text/html,unsafe")).toBe(false);
  });

  it("extracts nested image results only from image tools", () => {
    const output = JSON.stringify({ content: [{ image_url: "https://example.com/result.webp" }] });

    expect(extractToolImageSource("view_image", output)).toBe("https://example.com/result.webp");
    expect(extractToolImageSource("read_file", output)).toBeNull();
  });

  it("recognizes local image paths returned as plain text", () => {
    expect(extractToolImageSource("view_image", "C:\\temp\\capture.png")).toBe(
      "C:\\temp\\capture.png",
    );
  });

  it("ignores incomplete legacy tool items instead of crashing the shell", () => {
    expect(extractToolImageSource(undefined, null)).toBeNull();
    expect(extractToolImageSource(undefined, "C:\\temp\\capture.png")).toBeNull();
    expect(extractToolImageSource("view_image", undefined)).toBeNull();
  });
});
