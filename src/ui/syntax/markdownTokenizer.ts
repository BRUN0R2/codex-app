import type { SyntaxToken } from "./contracts";
import { appendToken, scanWhitespace } from "./scanner";
import { INITIAL_STATE, type TokenizedLine } from "./state";

export function tokenizeMarkdownLine(line: string): TokenizedLine {
  const tokens: SyntaxToken[] = [];
  let index = 0;
  const leadingWhitespace = scanWhitespace(line, 0);
  if (leadingWhitespace > 0) {
    appendToken(tokens, "text", line.slice(0, leadingWhitespace));
    index = leadingWhitespace;
  }
  const markerEnd = markdownMarkerEnd(line, index);
  if (markerEnd > index) {
    appendToken(tokens, "attribute", line.slice(index, markerEnd));
    index = markerEnd;
  }
  while (index < line.length) {
    if (line[index] === "`") {
      const closing = line.indexOf("`", index + 1);
      const end = closing < 0 ? line.length : closing + 1;
      appendToken(tokens, "string", line.slice(index, end));
      index = end;
      continue;
    }
    if (line[index] === "[") {
      const closing = line.indexOf("]", index + 1);
      if (closing >= 0) {
        appendToken(tokens, "property", line.slice(index, closing + 1));
        index = closing + 1;
        continue;
      }
    }
    appendToken(tokens, "text", line[index] ?? "");
    index += 1;
  }
  return { line: tokens, state: INITIAL_STATE };
}

function markdownMarkerEnd(line: string, start: number): number {
  if (line.startsWith("```", start) || line.startsWith("~~~", start)) {
    return line.length;
  }
  if (line[start] === "#") {
    let end = start;
    while (line[end] === "#") {
      end += 1;
    }
    return line[end] === " " ? end : start;
  }
  for (const marker of ["> ", "- ", "* ", "+ "]) {
    if (line.startsWith(marker, start)) {
      return start + marker.length;
    }
  }
  const ordered = /^\d+[.)]\s/u.exec(line.slice(start));
  return ordered === null ? start : start + ordered[0].length;
}
