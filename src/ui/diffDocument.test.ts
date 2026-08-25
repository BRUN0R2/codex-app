import { describe, expect, it } from "vitest";
import {
  countDiffDisplayRows,
  createDiffDocument,
  parseSplitDiff,
  parseUnifiedDiff,
  summarizeDiff,
} from "./diffDocument";

describe("diff document", () => {
  it("uses structural headers without exposing them as visual rows", () => {
    const diff =
      "--- before\n+++ after\n@@ -4,2 +4,2 @@ header\n-old line\n+new line\n context line";
    const rows = parseSplitDiff(diff);

    expect(rows.length).toBe(2);
    expect(rows[0]?.leftNumber).toBe(4);
    expect(rows[0]?.rightNumber).toBe(4);
    expect(rows[0]?.leftContent).toBe("old line");
    expect(rows[0]?.leftType).toBe("removed");
    expect(rows[0]?.rightContent).toBe("new line");
    expect(rows[0]?.rightType).toBe("added");
  });

  it("uses compact hunk boundaries without exposing marker rows", () => {
    const document = createDiffDocument("@@\n-before\n+after\n@@\n-second\n+next");

    expect(document.unifiedRows).toEqual([
      { content: "before", newNumber: null, oldNumber: 1, type: "deletion" },
      { content: "after", newNumber: 1, oldNumber: null, type: "addition" },
      { content: "second", newNumber: null, oldNumber: 2, type: "deletion" },
      { content: "next", newNumber: 2, oldNumber: null, type: "addition" },
    ]);
    expect(document.syntaxHunks.map((hunk) => hunk.lines)).toEqual([
      ["before", "after"],
      ["second", "next"],
    ]);
    expect(summarizeDiff("@@\n-before\n+after\n@@\n-second\n+next")).toEqual({
      additions: 2,
      deletions: 2,
    });
  });

  it("omits transport metadata from the presentation model", () => {
    const rows = parseUnifiedDiff(
      "diff --git a/file.ts b/file.ts\nindex 1111111..2222222 100644\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-before\n+after\n\\ No newline at end of file",
    );

    expect(rows).toEqual([
      { content: "before", newNumber: null, oldNumber: 1, type: "deletion" },
      { content: "after", newNumber: 1, oldNumber: null, type: "addition" },
    ]);
  });

  it("handles standalone additions and deletions", () => {
    const diff = "-only removed\n+only added";
    const rows = parseSplitDiff(diff);

    expect(rows.length).toBe(1); // - and + together pair up as modification
    expect(rows[0]?.leftType).toBe("removed");
    expect(rows[0]?.rightType).toBe("added");
  });

  it("counts display rows without materializing a document", () => {
    const diff =
      "diff --git a/file.ts b/file.ts\r\n--- a/file.ts\r\n+++ b/file.ts\r\n@@ -1,4 +1,3 @@\r\n-first\r\n-second\r\n+replacement\r\n context\r\n+tail\r\n\\ No newline at end of file\r\n";

    expect(countDiffDisplayRows(diff, "unified")).toBe(5);
    expect(countDiffDisplayRows(diff, "split")).toBe(4);
    expect(countDiffDisplayRows(diff, "unified")).toBe(parseUnifiedDiff(diff).length);
    expect(countDiffDisplayRows(diff, "split")).toBe(parseSplitDiff(diff).length);
  });

  it("keeps real old and new line numbers in unified mode", () => {
    const rows = parseUnifiedDiff(
      "@@ -24,3 +30,4 @@ function demo() {\n context\n-removed\n+added\n+another",
    );

    expect(rows[0]).toMatchObject({ oldNumber: 24, newNumber: 30, type: "context" });
    expect(rows[1]).toMatchObject({ oldNumber: 25, newNumber: null, type: "deletion" });
    expect(rows[2]).toMatchObject({ oldNumber: null, newNumber: 31, type: "addition" });
    expect(rows[3]).toMatchObject({ oldNumber: null, newNumber: 32, type: "addition" });
  });

  it("summarizes additions and deletions without counting file headers", () => {
    const diff = "--- a/file.ts\n+++ b/file.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n context";

    expect(summarizeDiff(diff)).toEqual({ additions: 2, deletions: 1 });
  });

  it("builds the split projection lazily and reuses its immutable result", () => {
    const document = createDiffDocument("@@ -1 +1 @@\n-before\n+after");
    const first = document.splitProjection();

    expect(document.splitProjection()).toBe(first);
    expect(first.rows).toHaveLength(1);
  });

  it("indexes syntax hunks and preserves source rows in split mode", () => {
    const document = createDiffDocument(
      "@@ -1,2 +1,2 @@\n-before\n+after\n context\n@@ -8 +8 @@\n-second\n+next",
    );
    const split = document.splitProjection();

    expect(document.syntaxHunks.map((hunk) => hunk.lines)).toEqual([
      ["before", "after", "context"],
      ["second", "next"],
    ]);
    expect(document.syntaxLocation(0)).toEqual({ hunkIndex: 0, lineIndex: 0 });
    expect(document.syntaxLocation(1)).toEqual({ hunkIndex: 0, lineIndex: 1 });
    expect(document.syntaxLocation(2)).toEqual({ hunkIndex: 0, lineIndex: 2 });
    expect(document.syntaxLocation(3)).toEqual({ hunkIndex: 1, lineIndex: 0 });
    expect(document.syntaxLocation(4)).toEqual({ hunkIndex: 1, lineIndex: 1 });
    expect([split.leftSourceIndexes[0], split.rightSourceIndexes[0]]).toEqual([1, 2]);
  });

  it("hides newline metadata and sizes gutters from real line numbers", () => {
    const document = createDiffDocument(
      "@@ -998,1 +12003,1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file",
    );

    expect(document.unifiedRows.map((line) => line.type)).toEqual(["deletion", "addition"]);
    expect(document.oldLineNumberDigits).toBe(3);
    expect(document.newLineNumberDigits).toBe(5);
  });

  it("parses a large diff without dropping any visible line", () => {
    const lineCount = 50_000;
    const diff = `@@ -1,${lineCount} +1,${lineCount} @@\n${Array.from(
      { length: lineCount },
      (_, index) => ` line ${index}`,
    ).join("\n")}`;
    const document = createDiffDocument(diff);

    expect(document.unifiedRows).toHaveLength(lineCount);
    expect(document.stats).toEqual({ additions: 0, deletions: 0 });
  });

  it("preserves the exact cardinality of replacement lines", () => {
    const document = createDiffDocument(
      "@@ -1,2 +1,3 @@\n-reason: String,\n-timeout_seconds: Option<u64>,\n+reason: String,\n+parallel_safe: bool,\n+timeout_seconds: Option<u64>,",
    );

    expect(
      document.unifiedRows.filter((line) => line.content === "timeout_seconds: Option<u64>,"),
    ).toHaveLength(2);
    expect(
      document.unifiedRows.filter(
        (line) => line.type === "addition" && line.content === "timeout_seconds: Option<u64>,",
      ),
    ).toHaveLength(1);
  });
});
