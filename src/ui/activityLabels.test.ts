import { describe, expect, it } from "vitest";

import {
  isBrowserTool,
  isExplorationTool,
  isFileReadTool,
  isWebSearchTool,
  toolIconName,
  toolLabel,
} from "./activityLabels";

describe("activity labels", () => {
  it("assigns the open-book glyph exclusively to file reads", () => {
    expect(isFileReadTool("read_file")).toBe(true);
    expect(isFileReadTool("READ_FILE")).toBe(true);
    expect(isExplorationTool("read_file")).toBe(false);
    expect(toolIconName("read_file")).toBe("read");
  });

  it("keeps browser control distinct from web search activity", () => {
    expect(isBrowserTool("browser_snapshot")).toBe(true);
    expect(isBrowserTool("browser_screenshot")).toBe(true);
    expect(isWebSearchTool("browser_snapshot")).toBe(false);
    expect(isWebSearchTool("web_search")).toBe(true);
    expect(toolIconName("browser_screenshot")).toBe("globe");
    expect(toolLabel("browser_screenshot")).toBe("Captura visual do navegador");
  });
});
