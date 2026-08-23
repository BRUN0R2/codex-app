export type SyntaxLanguage =
  | "bash"
  | "c"
  | "cpp"
  | "csharp"
  | "css"
  | "go"
  | "html"
  | "java"
  | "javascript"
  | "json"
  | "markdown"
  | "plainText"
  | "powershell"
  | "python"
  | "rust"
  | "sql"
  | "toml"
  | "typescript"
  | "yaml";

export type SyntaxTokenKind =
  | "attribute"
  | "comment"
  | "constant"
  | "function"
  | "keyword"
  | "number"
  | "operator"
  | "property"
  | "punctuation"
  | "string"
  | "text"
  | "type"
  | "variable";

export interface SyntaxToken {
  readonly kind: SyntaxTokenKind;
  readonly text: string;
}

export type SyntaxLine = readonly SyntaxToken[];
export type SyntaxBlock = readonly SyntaxLine[];

export interface SyntaxLimits {
  readonly maximumBytes: number;
  readonly maximumLineCharacters: number;
  readonly maximumLines: number;
}

export const DIFF_SYNTAX_LIMITS: SyntaxLimits = {
  maximumBytes: 128 * 1_024,
  maximumLineCharacters: 4 * 1_024,
  maximumLines: 4_096,
};

export type SyntaxFallbackReason =
  | "blockTooLarge"
  | "lineTooLong"
  | "plainLanguage"
  | "tooManyLines";

export type SyntaxTokenizationResult =
  | {
      readonly kind: "highlighted";
      readonly lines: SyntaxBlock;
    }
  | {
      readonly kind: "plain";
      readonly reason: SyntaxFallbackReason;
    };
