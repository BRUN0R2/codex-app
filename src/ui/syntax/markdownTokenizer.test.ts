import { describe, expect, it } from "vitest";

import type { SyntaxLine, SyntaxTokenKind } from "./contracts";
import { tokenizeMarkdownLine } from "./markdownTokenizer";
import { INITIAL_STATE } from "./state";

describe("markdown tokenizer", () => {
  it("consumes an unclosed inline backtick until the end of the line", () => {
    const tokenized = tokenizeMarkdownLine("valor `sem fechamento");

    expect(nonTextKinds(tokenized.line)).toEqual(["string"]);
    expect(tokenized.line.at(-1)?.text).toBe("`sem fechamento");
    expect(lineText(tokenized.line)).toBe("valor `sem fechamento");
    expect(tokenized.state).toEqual(INITIAL_STATE);
  });

  it("keeps a link without a closing bracket as plain text", () => {
    const tokenized = tokenizeMarkdownLine("veja [documentação incompleta");

    expect(nonTextKinds(tokenized.line)).toEqual([]);
    expect(lineText(tokenized.line)).toBe("veja [documentação incompleta");
  });

  it("only treats heading markers followed by a space as attributes", () => {
    const attached = tokenizeMarkdownLine("#TítuloSemEspaço");
    const spaced = tokenizeMarkdownLine("## Título com espaço");

    expect(nonTextKinds(attached.line)).toEqual([]);
    expect(nonTextKinds(spaced.line)).toEqual(["attribute"]);
    expect(spaced.line[0]?.text).toBe("##");
    expect(lineText(spaced.line)).toBe("## Título com espaço");
  });

  it("tokenizes an entire fence line as a single block marker", () => {
    const opening = tokenizeMarkdownLine("```rust");
    const closing = tokenizeMarkdownLine("```");
    const tildeFence = tokenizeMarkdownLine("~~~");

    expect(opening.line.map((token) => token.kind)).toEqual(["attribute"]);
    expect(lineText(opening.line)).toBe("```rust");
    expect(closing.line.map((token) => token.kind)).toEqual(["attribute"]);
    expect(tildeFence.line.map((token) => token.kind)).toEqual(["attribute"]);
    expect(closing.state).toEqual(INITIAL_STATE);
  });
});

function nonTextKinds(line: SyntaxLine): SyntaxTokenKind[] {
  return line.filter((token) => token.kind !== "text").map((token) => token.kind);
}

function lineText(line: SyntaxLine): string {
  return line.map((token) => token.text).join("");
}
