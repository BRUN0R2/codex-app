import { describe, expect, it } from "vitest";

import { resolveNewThreadWorkspace } from "./newThreadTarget";

describe("new thread target", () => {
  it("clears the project for the global New chat action", () => {
    expect(resolveNewThreadWorkspace()).toBeNull();
  });

  it("keeps the explicit project from a project action", () => {
    expect(resolveNewThreadWorkspace("D:\\workspace\\codex-app")).toBe("D:\\workspace\\codex-app");
  });
});
