import { describe, expect, it } from "vitest";

import { isExplorationTool, isFileReadTool, toolIconName } from "./activityLabels";

describe("activity labels", () => {
  it("assigns the open-book glyph exclusively to file reads", () => {
    expect(isFileReadTool("read_file")).toBe(true);
    expect(isFileReadTool("READ_FILE")).toBe(true);
    expect(isExplorationTool("read_file")).toBe(false);
    expect(toolIconName("read_file")).toBe("read");
  });
});
