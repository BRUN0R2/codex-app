import { utf8ByteLength } from "../../utf8";
import { tokenizeCodeLine } from "./codeTokenizer";
import type {
  SyntaxLanguage,
  SyntaxLimits,
  SyntaxLine,
  SyntaxTokenizationResult,
} from "./contracts";
import { type SyntaxProfile, syntaxProfile } from "./languages";
import { tokenizeMarkdownLine } from "./markdownTokenizer";
import { tokenizeMarkupLine } from "./markupTokenizer";
import { INITIAL_STATE, type LexicalState, type TokenizedLine } from "./state";

export const MARKDOWN_SYNTAX_LIMITS: SyntaxLimits = {
  maximumBytes: 512 * 1_024,
  maximumLineCharacters: 4 * 1_024,
  maximumLines: 10_000,
};

export function tokenizeSyntaxBlock(
  code: string,
  language: SyntaxLanguage,
  limits: SyntaxLimits = MARKDOWN_SYNTAX_LIMITS,
): SyntaxTokenizationResult {
  return tokenizeSyntaxLines(code.replace(/\r\n?/gu, "\n").split("\n"), language, limits);
}

export function tokenizeSyntaxLines(
  lines: readonly string[],
  language: SyntaxLanguage,
  limits: SyntaxLimits,
): SyntaxTokenizationResult {
  const fallback = validateSyntaxInput(lines, language, limits);
  if (fallback !== null) {
    return fallback;
  }

  const tokenizer = new SyntaxLineTokenizer(language);
  const highlighted: SyntaxLine[] = [];
  for (const line of lines) {
    highlighted.push(tokenizer.tokenize(line));
  }
  return { kind: "highlighted", lines: highlighted };
}

export class SyntaxLineTokenizer {
  readonly #profile: SyntaxProfile;
  #state: LexicalState = INITIAL_STATE;

  constructor(language: SyntaxLanguage) {
    this.#profile = syntaxProfile(language);
  }

  tokenize(line: string): SyntaxLine {
    const tokenized = tokenizeLine(line, this.#profile, this.#state);
    this.#state = tokenized.state;
    return tokenized.line;
  }
}

function tokenizeLine(line: string, profile: SyntaxProfile, state: LexicalState): TokenizedLine {
  return profile.mode === "markup"
    ? tokenizeMarkupLine(line, profile, state)
    : profile.mode === "markdown"
      ? tokenizeMarkdownLine(line)
      : tokenizeCodeLine(line, profile, state);
}

function validateSyntaxInput(
  lines: readonly string[],
  language: SyntaxLanguage,
  limits: SyntaxLimits,
): Extract<SyntaxTokenizationResult, { readonly kind: "plain" }> | null {
  if (language === "plainText") {
    return { kind: "plain", reason: "plainLanguage" };
  }
  if (lines.length > limits.maximumLines) {
    return { kind: "plain", reason: "tooManyLines" };
  }
  let byteLength = 0;
  for (const line of lines) {
    if (line.length > limits.maximumLineCharacters) {
      return { kind: "plain", reason: "lineTooLong" };
    }
    byteLength += utf8ByteLength(line) + 1;
    if (byteLength > limits.maximumBytes) {
      return { kind: "plain", reason: "blockTooLarge" };
    }
  }
  return null;
}
