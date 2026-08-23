import { describe, expect, it } from "vitest";

import { fileChangeLineStats } from "./fileChangeStats";

describe("file change line stats", () => {
  it("uses authoritative totals even when the diff preview is truncated", () => {
    expect(
      fileChangeLineStats({
        path: "src/removed.rs",
        kind: { type: "delete" },
        diff: "@@ -1,2 +0,0 @@\n-first\n-second\n[diff truncated]",
        lineStats: { additions: 0, deletions: 288 },
      }),
    ).toEqual({ additions: 0, deletions: 288 });
  });

  it("derives totals for persisted changes created before lineStats existed", () => {
    expect(
      fileChangeLineStats({
        path: "src/legacy.rs",
        kind: { type: "update", movePath: null },
        diff: "@@ -1 +1 @@\n-old\n+new",
        lineStats: null,
      }),
    ).toEqual({ additions: 1, deletions: 1 });
  });
});
