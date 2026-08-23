import { describe, expect, it } from "vitest";

import type { SyntaxBlock, SyntaxLanguage, SyntaxTokenKind } from "./contracts";
import { MARKDOWN_SYNTAX_LIMITS, tokenizeSyntaxBlock } from "./tokenizer";

describe("syntax tokenizer", () => {
  it("preserves Rust attributes, macros, raw strings and multiline state", () => {
    const source = [
      "#[test]",
      "fn benchmark() {",
      "    const TARGET_BYTES: usize = 64 * 1_024;",
      '    let value = r#"hello"#;',
      '    println!("ok");',
      "    /* open comment",
      "       close */",
      "}",
    ].join("\n");
    const block = highlighted(source, "rust");

    expect(nonTextKinds(block[0] ?? [])).toEqual(["attribute"]);
    expect(nonTextKinds(block[1] ?? [])).toEqual([
      "keyword",
      "function",
      "punctuation",
      "punctuation",
    ]);
    expect(nonTextKinds(block[2] ?? [])).toEqual([
      "keyword",
      "constant",
      "punctuation",
      "type",
      "operator",
      "number",
      "operator",
      "number",
      "punctuation",
    ]);
    expect(nonTextKinds(block[3] ?? [])).toContain("string");
    expect(nonTextKinds(block[4] ?? [])).toContain("attribute");
    expect(nonTextKinds(block[5] ?? [])).toEqual(["comment"]);
    expect(nonTextKinds(block[6] ?? [])).toEqual(["comment"]);
    expect(reconstruct(block)).toBe(source);
  });

  it("keeps Python triple strings distinct from hash comments", () => {
    const source = ['text = """start', "# still a string", 'end"""', "# actual comment"].join("\n");
    const block = highlighted(source, "python");

    expect(nonTextKinds(block[0] ?? [])).toContain("string");
    expect(nonTextKinds(block[1] ?? [])).toEqual(["string"]);
    expect(nonTextKinds(block[2] ?? [])).toEqual(["string"]);
    expect(nonTextKinds(block[3] ?? [])).toEqual(["comment"]);
    expect(reconstruct(block)).toBe(source);
  });

  it("supports nested Rust comments and C preprocessor directives", () => {
    const rust = highlighted(
      ["/* outer", "   /* nested */", "   outer continues */", "fn ready() {}"].join("\n"),
      "rust",
    );
    expect(rust.slice(0, 3).map(nonTextKinds)).toEqual([["comment"], ["comment"], ["comment"]]);
    expect(nonTextKinds(rust[3] ?? [])).toContain("function");

    const c = highlighted("#include <stdint.h>\nconst uint32_t value = 42;", "c");
    expect(nonTextKinds(c[0] ?? [])[0]).toBe("attribute");
    expect(nonTextKinds(c[1] ?? [])).toContain("type");
  });

  it("handles case-insensitive SQL, JSON properties and PowerShell variables", () => {
    const sql = highlighted("SELECT value FROM records WHERE id = 42 -- bounded", "sql");
    expect(nonTextKinds(sql[0] ?? [])).toEqual([
      "keyword",
      "keyword",
      "keyword",
      "operator",
      "number",
      "comment",
    ]);

    const json = highlighted('{"answer": 42, "enabled": true}', "json");
    expect(nonTextKinds(json[0] ?? [])).toEqual([
      "punctuation",
      "property",
      "punctuation",
      "number",
      "punctuation",
      "property",
      "punctuation",
      "constant",
      "punctuation",
    ]);

    const powershell = highlighted("$result = Get-Item $Path # visible", "powershell");
    expect(nonTextKinds(powershell[0] ?? [])).toContain("variable");
    expect(nonTextKinds(powershell[0] ?? [])).toContain("comment");
  });

  it("tokenizes markup tags and attributes without treating text as code", () => {
    const source = '<button aria-label="Salvar">Texto</button>';
    const block = highlighted(source, "html");

    expect(nonTextKinds(block[0] ?? [])).toEqual([
      "punctuation",
      "type",
      "property",
      "operator",
      "string",
      "punctuation",
      "punctuation",
      "type",
      "punctuation",
    ]);
    expect(reconstruct(block)).toBe(source);
  });

  it("fails predictably when a hard limit is reached", () => {
    expect(
      tokenizeSyntaxBlock("x".repeat(33), "rust", {
        maximumBytes: 32,
        maximumLineCharacters: 64,
        maximumLines: 2,
      }),
    ).toEqual({ kind: "plain", reason: "blockTooLarge" });
    expect(
      tokenizeSyntaxBlock("x".repeat(65), "rust", {
        maximumBytes: 1_024,
        maximumLineCharacters: 64,
        maximumLines: 2,
      }),
    ).toEqual({ kind: "plain", reason: "lineTooLong" });
    expect(
      tokenizeSyntaxBlock("a\nb\nc", "rust", {
        maximumBytes: 1_024,
        maximumLineCharacters: 64,
        maximumLines: 2,
      }),
    ).toEqual({ kind: "plain", reason: "tooManyLines" });
    expect(tokenizeSyntaxBlock("plain", "plainText", MARKDOWN_SYNTAX_LIMITS)).toEqual({
      kind: "plain",
      reason: "plainLanguage",
    });
  });
});

function highlighted(source: string, language: SyntaxLanguage): SyntaxBlock {
  const result = tokenizeSyntaxBlock(source, language);
  if (result.kind !== "highlighted") {
    throw new Error(`Expected highlighted syntax, received ${result.reason}.`);
  }
  return result.lines;
}

function nonTextKinds(line: SyntaxBlock[number]): SyntaxTokenKind[] {
  return line.filter((token) => token.kind !== "text").map((token) => token.kind);
}

function reconstruct(block: SyntaxBlock): string {
  return block.map((line) => line.map((token) => token.text).join("")).join("\n");
}
