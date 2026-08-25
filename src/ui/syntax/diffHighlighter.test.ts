import { describe, expect, it, vi } from "vitest";

import { createDiffDocument } from "../diffDocument";
import { DiffSyntaxHighlighter } from "./diffHighlighter";
import { SyntaxLineTokenizer } from "./tokenizer";

describe("diff syntax highlighter", () => {
  it("highlights a hunk incrementally and preserves multiline state", () => {
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
    const opening = highlighter.render(document, "src/main.rs", 2);
    const continuation = highlighter.render(document, "src/main.rs", 3);

    expect(opening?.some((token) => token.kind === "comment")).toBe(true);
    expect(continuation?.map((token) => token.kind)).toEqual(["comment"]);
    expect(continuation === null ? null : continuation.map((token) => token.text).join("")).toBe(
      "       continues */",
    );
    expect(highlighter.render(document, "src/main.rs", 3)).toBe(continuation);
    expect(new DiffSyntaxHighlighter().render(document, "src/main.rs", 3)).toBe(continuation);
  });

  it("tokenizes only through the furthest requested source line", () => {
    const document = createDiffDocument(
      "@@ -0,0 +1,5 @@\n+const one = 1;\n+const two = 2;\n+const three = 3;\n+const four = 4;\n+const five = 5;",
    );
    const tokenize = vi.spyOn(SyntaxLineTokenizer.prototype, "tokenize");
    const highlighter = new DiffSyntaxHighlighter();
    try {
      expect(highlighter.render(document, "src/incremental.ts", 0)).not.toBeNull();
      expect(tokenize).toHaveBeenCalledTimes(1);
      expect(highlighter.render(document, "src/incremental.ts", 2)).not.toBeNull();
      expect(tokenize).toHaveBeenCalledTimes(3);
      expect(highlighter.render(document, "src/incremental.ts", 1)).not.toBeNull();
      expect(tokenize).toHaveBeenCalledTimes(3);
    } finally {
      tokenize.mockRestore();
    }
  });

  it("falls back for unknown files and pathological hunks", () => {
    const ordinary = createDiffDocument("@@ -1 +1 @@\n+const answer = 42;");
    const highlighter = new DiffSyntaxHighlighter();
    expect(highlighter.render(ordinary, "file.unknown", 0)).toBeNull();

    const oversized = createDiffDocument(
      `@@ -1,257 +1,257 @@\n${Array.from(
        { length: 257 },
        (_, index) => ` const value_${index} = ${index};`,
      ).join("\n")}`,
    );
    expect(highlighter.render(oversized, "src/large.ts", 0)).toBeNull();

    const boundary = createDiffDocument(
      `@@ -1,256 +1,256 @@\n${Array.from(
        { length: 256 },
        (_, index) => ` const value_${index} = ${index};`,
      ).join("\n")}`,
    );
    expect(
      highlighter.render(boundary, "src/boundary.ts", 0)?.some((token) => token.kind === "keyword"),
    ).toBe(true);
  });

  it("highlights a created Rust file with hundreds of added lines", () => {
    const lineCount = 256;
    const document = createDiffDocument(
      `@@ -0,0 +1,${lineCount} @@\n${Array.from(
        { length: lineCount },
        (_, index) => `+const VALUE_${index}: usize = ${index} * 1_024;`,
      ).join("\n")}`,
    );
    const highlighter = new DiffSyntaxHighlighter();
    const opening = highlighter.render(document, "src/semantic.rs", 0);
    const ending = highlighter.render(document, "src/semantic.rs", lineCount - 1);

    expect(opening?.some((token) => token.kind === "keyword")).toBe(true);
    expect(opening?.some((token) => token.kind === "type")).toBe(true);
    expect(ending?.some((token) => token.kind === "number")).toBe(true);
  });
});
