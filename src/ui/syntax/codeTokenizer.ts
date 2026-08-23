import type { SyntaxToken, SyntaxTokenKind } from "./contracts";
import type { SyntaxProfile, SyntaxStringDelimiter } from "./languages";
import {
  appendToken,
  characterAt,
  consumeBlockComment,
  consumeDelimited,
  isConstantIdentifier,
  isDigit,
  isIdentifierStart,
  matchingDelimiter,
  matchingPrefix,
  matchingString,
  nextNonWhitespace,
  scanCharacters,
  scanIdentifier,
  scanNumber,
  scanVariable,
  scanWhitespace,
  startsWithUppercase,
} from "./scanner";
import { INITIAL_STATE, type LexicalState, type TokenizedLine } from "./state";

const OPERATOR_CHARACTERS = "+-*/%=&|^~<>!?";
const PUNCTUATION_CHARACTERS = "()[]{}.,;:";

export function tokenizeCodeLine(
  line: string,
  profile: SyntaxProfile,
  initialState: LexicalState,
): TokenizedLine {
  const tokens: SyntaxToken[] = [];
  let index = 0;
  let state =
    initialState.kind === "markupTag" || initialState.kind === "markupString"
      ? INITIAL_STATE
      : initialState;

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
  } else if (state.kind === "string") {
    const consumed = consumeDelimited(line, 0, state.delimiter, true);
    appendToken(tokens, "string", line.slice(0, consumed.end));
    index = consumed.end;
    state = consumed.closed ? INITIAL_STATE : state;
    if (!consumed.closed) {
      return { line: tokens, state };
    }
  }

  while (index < line.length) {
    const whitespaceEnd = scanWhitespace(line, index);
    if (whitespaceEnd > index) {
      appendToken(tokens, "text", line.slice(index, whitespaceEnd));
      index = whitespaceEnd;
      continue;
    }

    const lineComment = matchingPrefix(line, index, profile.lineComments);
    if (lineComment !== null) {
      appendToken(tokens, "comment", line.slice(index));
      break;
    }

    const blockComment = matchingDelimiter(line, index, profile.blockComments);
    if (blockComment !== null) {
      const consumed = consumeBlockComment(
        line,
        index,
        blockComment.start,
        blockComment.end,
        1,
        profile.nestedBlockComments,
        false,
      );
      appendToken(tokens, "comment", line.slice(index, consumed.end));
      index = consumed.end;
      if (!consumed.closed) {
        state = {
          depth: consumed.depth,
          end: blockComment.end,
          kind: "blockComment",
          nested: profile.nestedBlockComments,
          start: blockComment.start,
        };
        break;
      }
      continue;
    }

    if (profile.hashAttributes) {
      const attributeEnd = rustAttributeEnd(line, index);
      if (attributeEnd !== null) {
        appendToken(tokens, "attribute", line.slice(index, attributeEnd));
        index = attributeEnd;
        continue;
      }
    }

    if (profile.hashDirectives && line[index] === "#") {
      const nameStart = scanWhitespace(line, index + 1);
      const directiveEnd = scanIdentifier(line, nameStart);
      if (directiveEnd > nameStart) {
        appendToken(tokens, "attribute", line.slice(index, directiveEnd));
        index = directiveEnd;
        continue;
      }
    }

    if (profile.language === "rust") {
      const rawString = rustRawStringAt(line, index);
      if (rawString !== null) {
        const consumed = consumeDelimited(line, index, rawString, false);
        appendToken(tokens, "string", line.slice(index, consumed.end));
        index = consumed.end;
        if (!consumed.closed) {
          state = { delimiter: rawString, kind: "string" };
          break;
        }
        continue;
      }
      const lifetimeEnd = rustLifetimeEnd(line, index);
      if (lifetimeEnd !== null) {
        appendToken(tokens, "attribute", line.slice(index, lifetimeEnd));
        index = lifetimeEnd;
        continue;
      }
    }

    const stringDelimiter = matchingString(line, index, profile.strings);
    if (stringDelimiter !== null) {
      const consumed = consumeDelimited(line, index, stringDelimiter, false);
      appendToken(
        tokens,
        propertyKindAfter(line, consumed.end, profile) ?? "string",
        line.slice(index, consumed.end),
      );
      index = consumed.end;
      if (!consumed.closed && stringDelimiter.multiline) {
        state = { delimiter: stringDelimiter, kind: "string" };
        break;
      }
      continue;
    }

    if (profile.decorators && line[index] === "@") {
      const identifierEnd = scanIdentifier(line, index + 1);
      if (identifierEnd > index + 1) {
        appendToken(tokens, "attribute", line.slice(index, identifierEnd));
        index = identifierEnd;
        continue;
      }
    }

    if (profile.variablePrefix !== null && line.startsWith(profile.variablePrefix, index)) {
      const variableEnd = scanVariable(line, index + profile.variablePrefix.length);
      if (variableEnd > index + profile.variablePrefix.length) {
        appendToken(tokens, "variable", line.slice(index, variableEnd));
        index = variableEnd;
        continue;
      }
    }

    const character = characterAt(line, index);
    if (character === null) {
      break;
    }
    if (isDigit(character.value)) {
      const numberEnd = scanNumber(line, index);
      appendToken(tokens, "number", line.slice(index, numberEnd));
      index = numberEnd;
      continue;
    }
    if (isIdentifierStart(character.value)) {
      const identifierEnd = scanIdentifier(line, index);
      const word = line.slice(index, identifierEnd);
      appendToken(tokens, classifyIdentifier(line, identifierEnd, word, profile), word);
      index = identifierEnd;
      continue;
    }
    if (OPERATOR_CHARACTERS.includes(character.value)) {
      const operatorEnd = scanCharacters(line, index, OPERATOR_CHARACTERS);
      appendToken(tokens, "operator", line.slice(index, operatorEnd));
      index = operatorEnd;
      continue;
    }
    if (PUNCTUATION_CHARACTERS.includes(character.value)) {
      appendToken(tokens, "punctuation", character.value);
      index += character.width;
      continue;
    }
    appendToken(tokens, "text", character.value);
    index += character.width;
  }

  return { line: tokens, state };
}

function classifyIdentifier(
  line: string,
  end: number,
  word: string,
  profile: SyntaxProfile,
): SyntaxTokenKind {
  const normalized = profile.caseInsensitive ? word.toLowerCase() : word;
  if (profile.keywords.has(normalized)) {
    return ["false", "null", "none", "true", "undefined"].includes(normalized)
      ? "constant"
      : "keyword";
  }
  if (profile.types.has(normalized) || profile.types.has(word)) {
    return "type";
  }
  const next = nextNonWhitespace(line, end);
  if (profile.language === "rust" && next !== null && line[next] === "!") {
    return "attribute";
  }
  if (next !== null && line[next] === "(") {
    return "function";
  }
  if (
    next !== null &&
    profile.propertySeparators.some((separator) => line.startsWith(separator, next))
  ) {
    return "property";
  }
  if (isConstantIdentifier(word)) {
    return "constant";
  }
  if (profile.capitalizedIdentifiersAreTypes && startsWithUppercase(word)) {
    return "type";
  }
  return "text";
}

function propertyKindAfter(
  line: string,
  end: number,
  profile: SyntaxProfile,
): SyntaxTokenKind | null {
  const next = nextNonWhitespace(line, end);
  return next !== null &&
    profile.propertySeparators.some((separator) => line.startsWith(separator, next))
    ? "property"
    : null;
}

function rustRawStringAt(line: string, start: number): SyntaxStringDelimiter | null {
  let index = start;
  if (line[index] === "b") {
    index += 1;
  }
  if (line[index] !== "r") {
    return null;
  }
  index += 1;
  let hashes = "";
  while (line[index] === "#") {
    hashes += "#";
    index += 1;
  }
  if (line[index] !== '"') {
    return null;
  }
  return {
    end: `"${hashes}`,
    escape: "none",
    multiline: true,
    start: line.slice(start, index + 1),
  };
}

function rustAttributeEnd(line: string, start: number): number | null {
  if (line[start] !== "#") {
    return null;
  }
  const bracket = line[start + 1] === "!" ? start + 2 : start + 1;
  if (line[bracket] !== "[") {
    return null;
  }
  const end = line.indexOf("]", bracket + 1);
  return end < 0 ? line.length : end + 1;
}

function rustLifetimeEnd(line: string, start: number): number | null {
  if (line[start] !== "'" || line[start + 2] === "'") {
    return null;
  }
  const end = scanIdentifier(line, start + 1);
  return end > start + 1 ? end : null;
}
