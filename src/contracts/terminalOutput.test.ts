import { describe, expect, it } from "vitest";

import { normalizeTerminalText } from "./terminalOutput";

describe("normalizeTerminalText", () => {
  it("removes terminal color and style sequences", () => {
    expect(normalizeTerminalText("\u001b[1m\u001b[32mPASS\u001b[39m\u001b[22m\n")).toBe("PASS\n");
  });

  it("keeps hyperlink text without its terminal envelope", () => {
    expect(
      normalizeTerminalText("\u001b]8;;https://example.com\u001b\\OpenAI\u001b]8;;\u001b\\\n"),
    ).toBe("OpenAI\n");
  });

  it("resolves progress updates to the final visible line", () => {
    expect(normalizeTerminalText("loading 10%\rloading 100%\u001b[2K\rDone\r\n")).toBe("Done\n");
  });

  it("preserves Unicode and removes an incomplete trailing escape", () => {
    expect(normalizeTerminalText("ação concluída\u001b[31")).toBe("ação concluída");
  });
});
