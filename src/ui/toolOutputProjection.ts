import { utf8ByteLength } from "../utf8";
import { SAFE_IMAGE_DATA_MIME_PATTERN } from "./imageSource";
import { monospaceColumnCount } from "./monospace";
import type { SyntaxLine } from "./syntax/contracts";
import { syntaxLanguageFromPath } from "./syntax/languages";
import { SyntaxLineTokenizer } from "./syntax/tokenizer";

const MAX_SOURCE_HIGHLIGHT_BYTES: number = 256 * 1_024;
const MAX_SOURCE_LINE_CHARACTERS: number = 4 * 1_024;
const MAX_IMAGE_TOOL_SOURCE_BYTES: number = 16 * 1_048_576;
const MAX_IMAGE_TOOL_PATH_BYTES: number = 32 * 1_024;
const LAST_C0_CONTROL_CODE_UNIT: number = 0x1f;
const DELETE_CONTROL_CODE_UNIT: number = 0x7f;
const IMAGE_TOOL_DATA_URL = new RegExp(
  `${SAFE_IMAGE_DATA_MIME_PATTERN}(?:;base64)?,[^\\s]+$`,
  "iu",
);
const ABSOLUTE_IMAGE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)|\/)/u;

export interface SourceOutputLine {
  readonly content: string;
  readonly number: number;
}

export interface SourceOutputProjection {
  readonly lineNumberDigits: number;
  readonly lines: readonly SourceOutputLine[];
  readonly maximumColumns: number;
  readonly tokensAt: (index: number) => SyntaxLine | null;
}

export type SearchOutputLine =
  | {
      readonly content: string;
      readonly lineNumber: number;
      readonly path: string;
      readonly tokens: SyntaxLine | null;
      readonly type: "match";
    }
  | { readonly content: string; readonly type: "text" };

export function projectSourceOutput(text: string, path: string): SourceOutputProjection | null {
  const parsed = splitOutputLines(text).map((line) => {
    const match = /^(\d+): (.*)$/u.exec(line);
    if (match === null) {
      return null;
    }
    const number = Number(match[1]);
    const content = match[2];
    return Number.isSafeInteger(number) && number > 0 && content !== undefined
      ? { content, number }
      : null;
  });
  if (parsed.some((line) => line === null)) {
    return null;
  }

  const language = syntaxLanguageFromPath(path);
  const tokenizer = language === "plainText" ? null : new SyntaxLineTokenizer(language);
  const cachedTokens: Array<SyntaxLine | null | undefined> = [];
  let highlightedBytes = 0;
  let highlighting = tokenizer !== null;
  let lineNumberDigits = 1;
  let maximumColumns = 1;
  const lines = parsed.map((line) => {
    if (line === null) {
      throw new Error("The read output changed after validation.");
    }
    lineNumberDigits = Math.max(lineNumberDigits, String(line.number).length);
    maximumColumns = Math.max(maximumColumns, monospaceColumnCount(line.content));
    return line;
  });
  return {
    lineNumberDigits,
    lines,
    maximumColumns,
    tokensAt(index) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= lines.length) {
        throw new Error("The file-read syntax index is invalid.");
      }
      if (tokenizer === null) {
        return null;
      }
      for (let nextIndex = cachedTokens.length; nextIndex <= index; nextIndex += 1) {
        const line = lines[nextIndex];
        if (line === undefined) {
          throw new Error(`Read line ${nextIndex} does not exist.`);
        }
        const lineBytes = utf8ByteLength(line.content) + 1;
        highlighting =
          highlighting &&
          line.content.length <= MAX_SOURCE_LINE_CHARACTERS &&
          highlightedBytes + lineBytes <= MAX_SOURCE_HIGHLIGHT_BYTES;
        cachedTokens.push(highlighting ? tokenizer.tokenize(line.content) : null);
        highlightedBytes += lineBytes;
      }
      return cachedTokens[index] ?? null;
    },
  };
}

export function projectSearchOutput(text: string): readonly SearchOutputLine[] {
  return splitOutputLines(text).map((line) => {
    const match = /^(.+?):(\d+):(.*)$/u.exec(line);
    if (match === null) {
      return { content: line, type: "text" };
    }
    const path = match[1];
    const lineNumber = Number(match[2]);
    const content = match[3];
    if (
      path === undefined ||
      content === undefined ||
      !Number.isSafeInteger(lineNumber) ||
      lineNumber <= 0
    ) {
      return { content: line, type: "text" };
    }
    const language = syntaxLanguageFromPath(path);
    const tokens =
      language === "plainText" || content.length > MAX_SOURCE_LINE_CHARACTERS
        ? null
        : new SyntaxLineTokenizer(language).tokenize(content);
    return { content, lineNumber, path, tokens, type: "match" };
  });
}

export function projectImageToolOutput(text: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const object = value as {
    readonly image_path?: unknown;
    readonly image_url?: unknown;
  };
  if (Object.keys(object).length !== 1) {
    return null;
  }
  if (typeof object.image_path === "string") {
    const path = object.image_path;
    return path.length > 0 &&
      utf8ByteLength(path) <= MAX_IMAGE_TOOL_PATH_BYTES &&
      !hasControlCharacter(path) &&
      ABSOLUTE_IMAGE_PATH.test(path)
      ? path
      : null;
  }
  if (typeof object.image_url !== "string") {
    return null;
  }
  const source = object.image_url;
  if (source.length === 0 || utf8ByteLength(source) > MAX_IMAGE_TOOL_SOURCE_BYTES) {
    return null;
  }
  if (IMAGE_TOOL_DATA_URL.test(source)) {
    return source;
  }
  try {
    const url = new URL(source);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username.length === 0 &&
      url.password.length === 0
      ? source
      : null;
  } catch {
    return null;
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= LAST_C0_CONTROL_CODE_UNIT || codeUnit === DELETE_CONTROL_CODE_UNIT) {
      return true;
    }
  }
  return false;
}

export function splitOutputLines(text: string): readonly string[] {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}
