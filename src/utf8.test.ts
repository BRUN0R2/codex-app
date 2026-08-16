import { describe, expect, it } from "vitest";

import { exceedsUtf8ByteLength, utf8ByteLength } from "./utf8";

describe("medição UTF-8", () => {
  it.each([
    "",
    "texto ASCII",
    "acentuação em português",
    "emoji 😀 e ideogramas 日本語",
    "\u{10ffff}",
    "\ud800",
    "\udc00",
    "x".repeat(128 * 1_024),
    "😀".repeat(40_000),
  ])("coincide com TextEncoder para %j", (value) => {
    expect(utf8ByteLength(value)).toBe(new TextEncoder().encode(value).byteLength);
  });

  it("interrompe a validação assim que o limite em bytes é excedido", () => {
    expect(exceedsUtf8ByteLength("abc", 3)).toBe(false);
    expect(exceedsUtf8ByteLength("😀", 3)).toBe(true);
    expect(exceedsUtf8ByteLength("😀", 4)).toBe(false);
    expect(exceedsUtf8ByteLength("á".repeat(40_000), 64 * 1_024)).toBe(true);
  });
});
