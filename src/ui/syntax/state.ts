import type { SyntaxLine } from "./contracts";
import type { SyntaxStringDelimiter } from "./languages";

export type LexicalState =
  | {
      readonly depth: number;
      readonly end: string;
      readonly kind: "blockComment";
      readonly nested: boolean;
      readonly start: string;
    }
  | { readonly delimiter: SyntaxStringDelimiter; readonly kind: "markupString" }
  | { readonly delimiter: SyntaxStringDelimiter; readonly kind: "string" }
  | { readonly expectTagName: boolean; readonly kind: "markupTag" }
  | { readonly kind: "plain" };

export interface TokenizedLine {
  readonly line: SyntaxLine;
  readonly state: LexicalState;
}

export const INITIAL_STATE: LexicalState = { kind: "plain" };
