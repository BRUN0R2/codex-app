import { utf8ByteLength } from "../utf8";
import { SAFE_IMAGE_DATA_MIME_PATTERN } from "./imageSource";
import type { SyntaxLine } from "./syntax/contracts";
import { syntaxLanguageFromPath } from "./syntax/languages";
import { SyntaxLineTokenizer } from "./syntax/tokenizer";

const MAX_SOURCE_HIGHLIGHT_BYTES: number = 256 * 1_024;
const MAX_SOURCE_LINE_CHARACTERS: number = 4 * 1_024;
const MAX_IMAGE_TOOL_SOURCE_BYTES: number = 16 * 1_048_576;
const IMAGE_TOOL_DATA_URL = new RegExp(
  `${SAFE_IMAGE_DATA_MIME_PATTERN}(?:;base64)?,[^\\s]+$`,
  "iu",
);

export interface SourceOutputLine {
  readonly content: string;
  readonly number: number;
  readonly tokens: SyntaxLine | null;
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

export function projectSourceOutput(
  text: string,
  path: string,
): readonly SourceOutputLine[] | null {
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
  let highlightedBytes = 0;
  let highlighting = tokenizer !== null;
  return parsed.map((line) => {
    if (line === null) {
      throw new Error("A saída de leitura mudou depois de ser validada.");
    }
    const lineBytes = utf8ByteLength(line.content) + 1;
    highlighting =
      highlighting &&
      line.content.length <= MAX_SOURCE_LINE_CHARACTERS &&
      highlightedBytes + lineBytes <= MAX_SOURCE_HIGHLIGHT_BYTES;
    const tokens = highlighting ? (tokenizer?.tokenize(line.content) ?? null) : null;
    highlightedBytes += lineBytes;
    return { ...line, tokens };
  });
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
  const object = value as { readonly image_url?: unknown };
  if (Object.keys(object).length !== 1 || typeof object.image_url !== "string") {
    return null;
  }
  const source = object.image_url;
  if (
    source.length === 0 ||
    new TextEncoder().encode(source).length > MAX_IMAGE_TOOL_SOURCE_BYTES
  ) {
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

export function splitOutputLines(text: string): readonly string[] {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}
