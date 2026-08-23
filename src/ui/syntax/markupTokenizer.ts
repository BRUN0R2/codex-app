import type { SyntaxToken } from "./contracts";
import type { SyntaxProfile } from "./languages";
import {
  appendToken,
  characterAt,
  consumeBlockComment,
  consumeDelimited,
  isIdentifierStart,
  matchingDelimiter,
  matchingString,
  scanMarkupIdentifier,
  scanWhitespace,
} from "./scanner";
import { INITIAL_STATE, type LexicalState, type TokenizedLine } from "./state";

export function tokenizeMarkupLine(
  line: string,
  profile: SyntaxProfile,
  initialState: LexicalState,
): TokenizedLine {
  const tokens: SyntaxToken[] = [];
  let index = 0;
  let state = initialState;
  let expectTagName = state.kind === "markupTag" ? state.expectTagName : false;
  let insideTag = initialState.kind === "markupTag" || initialState.kind === "markupString";

  if (state.kind === "blockComment") {
    const consumed = consumeBlockComment(
      line,
      0,
      state.start,
      state.end,
      state.depth,
      state.nested,
      true,
    );
    appendToken(tokens, "comment", line.slice(0, consumed.end));
    if (!consumed.closed) {
      return { line: tokens, state: { ...state, depth: consumed.depth } };
    }
    index = consumed.end;
    state = INITIAL_STATE;
  } else if (state.kind === "markupString") {
    const consumed = consumeDelimited(line, 0, state.delimiter, true);
    appendToken(tokens, "string", line.slice(0, consumed.end));
    index = consumed.end;
    if (!consumed.closed) {
      return { line: tokens, state };
    }
    state = { expectTagName: false, kind: "markupTag" };
  }

  while (index < line.length) {
    if (!insideTag) {
      const comment = matchingDelimiter(line, index, profile.blockComments);
      if (comment !== null) {
        const consumed = consumeBlockComment(
          line,
          index,
          comment.start,
          comment.end,
          1,
          false,
          false,
        );
        appendToken(tokens, "comment", line.slice(index, consumed.end));
        if (!consumed.closed) {
          return {
            line: tokens,
            state: {
              depth: consumed.depth,
              end: comment.end,
              kind: "blockComment",
              nested: false,
              start: comment.start,
            },
          };
        }
        index = consumed.end;
        continue;
      }
      const tagStart = line.indexOf("<", index);
      if (tagStart < 0) {
        appendToken(tokens, "text", line.slice(index));
        break;
      }
      appendToken(tokens, "text", line.slice(index, tagStart));
      const punctuationEnd = line[tagStart + 1] === "/" ? tagStart + 2 : tagStart + 1;
      appendToken(tokens, "punctuation", line.slice(tagStart, punctuationEnd));
      index = punctuationEnd;
      expectTagName = true;
      insideTag = true;
      continue;
    }

    const whitespaceEnd = scanWhitespace(line, index);
    if (whitespaceEnd > index) {
      appendToken(tokens, "text", line.slice(index, whitespaceEnd));
      index = whitespaceEnd;
      continue;
    }
    if (line[index] === ">") {
      appendToken(tokens, "punctuation", ">");
      index += 1;
      insideTag = false;
      expectTagName = false;
      continue;
    }
    if (line.startsWith("/>", index)) {
      appendToken(tokens, "punctuation", "/>");
      index += 2;
      insideTag = false;
      expectTagName = false;
      continue;
    }
    const delimiter = matchingString(line, index, profile.strings);
    if (delimiter !== null) {
      const consumed = consumeDelimited(line, index, delimiter, false);
      appendToken(tokens, "string", line.slice(index, consumed.end));
      index = consumed.end;
      if (!consumed.closed) {
        return { line: tokens, state: { delimiter, kind: "markupString" } };
      }
      continue;
    }
    const character = characterAt(line, index);
    if (character !== null && isIdentifierStart(character.value)) {
      const end = scanMarkupIdentifier(line, index);
      appendToken(tokens, expectTagName ? "type" : "property", line.slice(index, end));
      index = end;
      expectTagName = false;
      continue;
    }
    if (line[index] === "=") {
      appendToken(tokens, "operator", "=");
      index += 1;
      continue;
    }
    if (character === null) {
      break;
    }
    appendToken(tokens, "punctuation", character.value);
    index += character.width;
  }

  return {
    line: tokens,
    state: insideTag ? { expectTagName, kind: "markupTag" } : INITIAL_STATE,
  };
}
