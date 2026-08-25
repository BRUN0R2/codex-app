import type { SyntaxBlock, SyntaxLine, SyntaxTokenKind } from "./contracts";
import { syntaxLanguageFromAlias } from "./languages";
import { MARKDOWN_SYNTAX_LIMITS, tokenizeSyntaxBlock } from "./tokenizer";

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function highlightCodeToHtml(code: string, language: string | null | undefined): string {
  const resolved = syntaxLanguageFromAlias(language);
  const result = tokenizeSyntaxBlock(code, resolved, MARKDOWN_SYNTAX_LIMITS);
  return result.kind === "highlighted" ? syntaxBlockToHtml(result.lines) : escapeHtml(code);
}

function syntaxBlockToHtml(block: SyntaxBlock): string {
  return block.map(syntaxLineToHtml).join("\n");
}

export function syntaxLineToHtml(line: SyntaxLine): string {
  let html = "";
  for (const token of line) {
    const escaped = escapeHtml(token.text);
    html +=
      token.kind === "text"
        ? escaped
        : `<span class="syntax-token ${syntaxTokenClass(token.kind)}">${escaped}</span>`;
  }
  return html;
}

export function syntaxTokenClass(kind: Exclude<SyntaxTokenKind, "text">): string {
  switch (kind) {
    case "attribute":
      return "token-attribute";
    case "comment":
      return "token-comment";
    case "constant":
      return "token-constant";
    case "function":
      return "token-function";
    case "keyword":
      return "token-keyword";
    case "number":
      return "token-number";
    case "operator":
      return "token-operator";
    case "property":
      return "token-property";
    case "punctuation":
      return "token-punctuation";
    case "string":
      return "token-string";
    case "type":
      return "token-type";
    case "variable":
      return "token-variable";
  }
}
