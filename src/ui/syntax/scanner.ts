import type { SyntaxToken, SyntaxTokenKind } from "./contracts";
import type { SyntaxStringDelimiter } from "./languages";

const UNICODE_IDENTIFIER_START = /^[$_\p{ID_Start}]$/u;
const UNICODE_IDENTIFIER_CONTINUE = /^(?:[$_]|\u200c|\u200d|\p{ID_Continue})$/u;

interface ScannedCharacter {
  readonly value: string;
  readonly width: number;
}

export function appendToken(tokens: SyntaxToken[], kind: SyntaxTokenKind, text: string): void {
  if (text.length === 0) {
    return;
  }
  const previous = tokens.at(-1);
  if (previous?.kind === kind) {
    tokens[tokens.length - 1] = { kind, text: previous.text + text };
  } else {
    tokens.push({ kind, text });
  }
}

export function consumeBlockComment(
  line: string,
  start: number,
  opening: string,
  closing: string,
  initialDepth: number,
  nested: boolean,
  continuing: boolean,
): { readonly closed: boolean; readonly depth: number; readonly end: number } {
  let depth = initialDepth;
  let index = continuing ? start : start + opening.length;
  while (index < line.length) {
    const closingIndex = line.indexOf(closing, index);
    const openingIndex = nested ? line.indexOf(opening, index) : -1;
    if (closingIndex < 0) {
      return { closed: false, depth, end: line.length };
    }
    if (openingIndex >= 0 && openingIndex < closingIndex) {
      depth += 1;
      index = openingIndex + opening.length;
      continue;
    }
    depth -= 1;
    index = closingIndex + closing.length;
    if (depth === 0) {
      return { closed: true, depth, end: index };
    }
  }
  return { closed: false, depth, end: line.length };
}

export function consumeDelimited(
  line: string,
  start: number,
  delimiter: SyntaxStringDelimiter,
  continuing: boolean,
): { readonly closed: boolean; readonly end: number } {
  let index = continuing ? start : start + delimiter.start.length;
  while (index < line.length) {
    if (line.startsWith(delimiter.end, index)) {
      if (
        delimiter.escape === "double" &&
        line.startsWith(delimiter.end, index + delimiter.end.length)
      ) {
        index += delimiter.end.length * 2;
        continue;
      }
      return { closed: true, end: index + delimiter.end.length };
    }
    if (delimiter.escape === "backslash" && line[index] === "\\") {
      const escaped = characterAt(line, index + 1);
      index += 1 + (escaped?.width ?? 0);
      continue;
    }
    index += characterAt(line, index)?.width ?? 1;
  }
  return { closed: false, end: line.length };
}

export function matchingDelimiter<T extends { readonly start: string }>(
  line: string,
  index: number,
  delimiters: readonly T[],
): T | null {
  return delimiters.find((delimiter) => line.startsWith(delimiter.start, index)) ?? null;
}

export function matchingPrefix(
  line: string,
  index: number,
  prefixes: readonly string[],
): string | null {
  return prefixes.find((prefix) => line.startsWith(prefix, index)) ?? null;
}

export function matchingString(
  line: string,
  index: number,
  delimiters: readonly SyntaxStringDelimiter[],
): SyntaxStringDelimiter | null {
  return matchingDelimiter(line, index, delimiters);
}

export function scanWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const character = value.charCodeAt(index);
    if (character !== 0x20 && character !== 0x09 && character !== 0x0a && character !== 0x0d) {
      break;
    }
    index += 1;
  }
  return index;
}

export function scanIdentifier(value: string, start: number): number {
  let index = start;
  let character = characterAt(value, index);
  if (character === null || !isIdentifierStart(character.value)) {
    return start;
  }
  index += character.width;
  character = characterAt(value, index);
  while (character !== null && isIdentifierContinue(character.value)) {
    index += character.width;
    character = characterAt(value, index);
  }
  return index;
}

export function scanMarkupIdentifier(value: string, start: number): number {
  let index = scanIdentifier(value, start);
  while (index < value.length && ["-", ":", "."].includes(value[index] ?? "")) {
    const next = scanIdentifier(value, index + 1);
    if (next === index + 1) {
      break;
    }
    index = next;
  }
  return index;
}

export function scanVariable(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const character = characterAt(value, index);
    if (
      character === null ||
      (!isIdentifierContinue(character.value) && ![":", "?", "^"].includes(character.value))
    ) {
      break;
    }
    index += character.width;
  }
  return index;
}

export function scanNumber(value: string, start: number): number {
  let index = start;
  if (value.startsWith("0x", start) || value.startsWith("0X", start)) {
    index += 2;
    while (isHexDigitOrSeparator(value[index] ?? "")) {
      index += 1;
    }
  } else if (
    value.startsWith("0b", start) ||
    value.startsWith("0B", start) ||
    value.startsWith("0o", start) ||
    value.startsWith("0O", start)
  ) {
    index += 2;
    while (isDigit(value[index] ?? "") || value[index] === "_") {
      index += 1;
    }
  } else {
    while (isDigit(value[index] ?? "") || value[index] === "_") {
      index += 1;
    }
    if (value[index] === "." && isDigit(value[index + 1] ?? "")) {
      index += 1;
      while (isDigit(value[index] ?? "") || value[index] === "_") {
        index += 1;
      }
    }
    if (value[index] === "e" || value[index] === "E") {
      const exponentStart = index;
      index += 1;
      if (value[index] === "+" || value[index] === "-") {
        index += 1;
      }
      const digitsStart = index;
      while (isDigit(value[index] ?? "") || value[index] === "_") {
        index += 1;
      }
      if (index === digitsStart) {
        index = exponentStart;
      }
    }
  }
  while (index < value.length && isAsciiIdentifierContinue(value[index] ?? "")) {
    index += 1;
  }
  return index;
}

export function scanCharacters(value: string, start: number, allowed: string): number {
  let index = start;
  while (index < value.length && allowed.includes(value[index] ?? "")) {
    index += 1;
  }
  return index;
}

export function nextNonWhitespace(value: string, start: number): number | null {
  const end = scanWhitespace(value, start);
  return end < value.length ? end : null;
}

export function characterAt(value: string, index: number): ScannedCharacter | null {
  if (index >= value.length) {
    return null;
  }
  const point = value.codePointAt(index);
  if (point === undefined) {
    return null;
  }
  const character = String.fromCodePoint(point);
  return { value: character, width: character.length };
}

export function isIdentifierStart(character: string): boolean {
  return isAsciiLetter(character) || character === "_" || character === "$"
    ? true
    : UNICODE_IDENTIFIER_START.test(character);
}

export function isDigit(character: string): boolean {
  return character >= "0" && character <= "9";
}

export function isConstantIdentifier(value: string): boolean {
  return (
    value.length > 1 &&
    value === value.toUpperCase() &&
    value !== value.toLowerCase() &&
    /[A-Z]/u.test(value)
  );
}

export function startsWithUppercase(value: string): boolean {
  const first = characterAt(value, 0)?.value;
  return first !== undefined && first !== first.toLowerCase() && first === first.toUpperCase();
}

function isIdentifierContinue(character: string): boolean {
  return isIdentifierStart(character) || isDigit(character)
    ? true
    : UNICODE_IDENTIFIER_CONTINUE.test(character);
}

function isAsciiLetter(character: string): boolean {
  return (character >= "a" && character <= "z") || (character >= "A" && character <= "Z");
}

function isAsciiIdentifierContinue(character: string): boolean {
  return isAsciiLetter(character) || isDigit(character) || character === "_";
}

function isHexDigitOrSeparator(character: string): boolean {
  return (
    isDigit(character) ||
    (character >= "a" && character <= "f") ||
    (character >= "A" && character <= "F") ||
    character === "_"
  );
}
