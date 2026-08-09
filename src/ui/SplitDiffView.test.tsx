import { describe, expect, it } from "vitest";
import { parseSplitDiff, parseUnifiedDiff, summarizeDiff } from "./SplitDiffView";

describe("SplitDiffView", () => {
  it("parses headers, removals, additions and context lines correctly", () => {
    const diff =
      "--- before\n+++ after\n@@ -4,2 +4,2 @@ header\n-old line\n+new line\n context line";
    const rows = parseSplitDiff(diff);

    expect(rows.length).toBe(3);
    expect(rows[0]?.leftType).toBe("header");
    expect(rows[1]?.leftNumber).toBe(4);
    expect(rows[1]?.rightNumber).toBe(4);
    expect(rows[1]?.leftContent).toBe("old line");
    expect(rows[1]?.leftType).toBe("removed");
    expect(rows[1]?.rightContent).toBe("new line");
    expect(rows[1]?.rightType).toBe("added");
  });

  it("handles standalone additions and deletions", () => {
    const diff = "-only removed\n+only added";
    const rows = parseSplitDiff(diff);

    expect(rows.length).toBe(1); // - and + together pair up as modification
    expect(rows[0]?.leftType).toBe("removed");
    expect(rows[0]?.rightType).toBe("added");
  });

  it("keeps real old and new line numbers in unified mode", () => {
    const rows = parseUnifiedDiff(
      "@@ -24,3 +30,4 @@ function demo() {\n context\n-removed\n+added\n+another",
    );

    expect(rows[1]).toMatchObject({ oldNumber: 24, newNumber: 30, type: "context" });
    expect(rows[2]).toMatchObject({ oldNumber: 25, newNumber: null, type: "deletion" });
    expect(rows[3]).toMatchObject({ oldNumber: null, newNumber: 31, type: "addition" });
    expect(rows[4]).toMatchObject({ oldNumber: null, newNumber: 32, type: "addition" });
  });

  it("summarizes additions and deletions without counting file headers", () => {
    const diff = "--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n context";

    expect(summarizeDiff(diff)).toEqual({ additions: 2, deletions: 1 });
  });
});
