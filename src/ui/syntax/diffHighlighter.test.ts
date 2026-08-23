import { describe, expect, it } from "vitest";

import { createDiffDocument } from "../diffDocument";
import { DiffSyntaxHighlighter } from "./diffHighlighter";

describe("diff syntax highlighter", () => {
  it("highlights a complete hunk once and preserves multiline state", () => {
    const document = createDiffDocument(
      [
        "@@ -1,4 +1,4 @@",
        " fn main() {",
        "-    /* old comment",
        "+    /* new comment",
        "        continues */",
        " }",
      ].join("\n"),
    );
    const highlighter = new DiffSyntaxHighlighter();
    const opening = highlighter.render(document, "src/main.rs", 3);
    const continuation = highlighter.render(document, "src/main.rs", 4);

    expect(opening?.some((token) => token.kind === "comment")).toBe(true);
    expect(continuation?.map((token) => token.kind)).toEqual(["comment"]);
    expect(continuation === null ? null : continuation.map((token) => token.text).join("")).toBe(
      "       continues */",
    );
    expect(highlighter.render(document, "src/main.rs", 4)).toBe(continuation);
  });

  it("falls back for unknown files and pathological hunks", () => {
    const ordinary = createDiffDocument("@@ -1 +1 @@\n+const answer = 42;");
    const highlighter = new DiffSyntaxHighlighter();
    expect(highlighter.render(ordinary, "file.unknown", 1)).toBeNull();

    const large = createDiffDocument(
      `@@ -1,4097 +1,4097 @@\n${Array.from(
        { length: 4_097 },
        (_, index) => ` const value_${index} = ${index};`,
      ).join("\n")}`,
    );
    expect(highlighter.render(large, "src/large.ts", 1)).toBeNull();
  });

  it("highlights a created Rust file with hundreds of added lines", () => {
    const lineCount = 338;
    const document = createDiffDocument(
      `@@ -0,0 +1,${lineCount} @@\n${Array.from(
        { length: lineCount },
        (_, index) => `+const VALUE_${index}: usize = ${index} * 1_024;`,
      ).join("\n")}`,
    );
    const highlighter = new DiffSyntaxHighlighter();
    const opening = highlighter.render(document, "src/semantic.rs", 1);
    const ending = highlighter.render(document, "src/semantic.rs", lineCount);

    expect(opening?.some((token) => token.kind === "keyword")).toBe(true);
    expect(opening?.some((token) => token.kind === "type")).toBe(true);
    expect(ending?.some((token) => token.kind === "number")).toBe(true);
  });
});
