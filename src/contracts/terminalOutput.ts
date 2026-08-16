const ESCAPE = 0x1b;
const BELL = 0x07;

export function normalizeTerminalText(value: string): string {
  return normalizeControls(stripEscapeSequences(value));
}

function stripEscapeSequences(value: string): string {
  const output: string[] = [];
  let index = 0;
  while (index < value.length) {
    if (value.charCodeAt(index) === ESCAPE) {
      index = skipEscapeSequence(value, index);
    } else {
      output.push(value[index] ?? "");
      index += 1;
    }
  }
  return output.join("");
}

function skipEscapeSequence(value: string, escapeIndex: number): number {
  const kind = value.charCodeAt(escapeIndex + 1);
  if (Number.isNaN(kind)) {
    return value.length;
  }
  if (kind === 0x5b) {
    return skipControlSequence(value, escapeIndex + 2);
  }
  if (kind === 0x5d) {
    return skipStringSequence(value, escapeIndex + 2, true);
  }
  if (kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) {
    return skipStringSequence(value, escapeIndex + 2, false);
  }

  let index = escapeIndex + 1;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x2f) {
      break;
    }
    index += 1;
  }
  const finalCode = value.charCodeAt(index);
  if (finalCode >= 0x30 && finalCode <= 0x7e) {
    return index + 1;
  }
  return Number.isNaN(finalCode) ? value.length : escapeIndex + 1;
}

function skipControlSequence(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return index + 1;
    }
  }
  return value.length;
}

function skipStringSequence(value: string, start: number, bellTerminated: boolean): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (bellTerminated && code === BELL) {
      return index + 1;
    }
    if (code === ESCAPE && value.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return value.length;
}

function normalizeControls(value: string): string {
  const output: string[] = [];
  const line: string[] = [];
  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index);
    if (codePoint === undefined) {
      break;
    }
    const character = String.fromCodePoint(codePoint);
    index += character.length;
    if (codePoint === 0x0d && value.charCodeAt(index) === 0x0a) {
      index += 1;
      flushLine(output, line, true);
    } else if (codePoint === 0x0d) {
      line.length = 0;
    } else if (codePoint === 0x0a) {
      flushLine(output, line, true);
    } else if (codePoint === 0x08) {
      line.pop();
    } else if (codePoint === 0x09) {
      line.push(character);
    } else if (!isControl(codePoint)) {
      line.push(character);
    }
  }
  flushLine(output, line, false);
  return output.join("");
}

function flushLine(output: string[], line: string[], newline: boolean): void {
  output.push(...line);
  line.length = 0;
  if (newline) {
    output.push("\n");
  }
}

function isControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}
