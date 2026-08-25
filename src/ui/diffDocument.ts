import { monospaceColumnCount } from "./monospace";
import { DIFF_SYNTAX_LIMITS } from "./syntax/contracts";

export type UnifiedDiffLineType = "addition" | "context" | "deletion";

export interface UnifiedDiffLine {
  readonly content: string;
  readonly newNumber: number | null;
  readonly oldNumber: number | null;
  readonly type: UnifiedDiffLineType;
}

export interface DiffStats {
  readonly additions: number;
  readonly deletions: number;
}

export interface SplitDiffRow {
  readonly leftNumber: number | null;
  readonly leftContent: string;
  readonly leftType: "removed" | "empty" | "normal";
  readonly rightNumber: number | null;
  readonly rightContent: string;
  readonly rightType: "added" | "empty" | "normal";
}

export interface SplitDiffProjection {
  readonly leftMaximumColumns: number;
  readonly leftSourceIndexes: Uint32Array;
  readonly rightMaximumColumns: number;
  readonly rightSourceIndexes: Uint32Array;
  readonly rows: readonly SplitDiffRow[];
}

export interface DiffSyntaxHunk {
  readonly characterLength: number;
  readonly lineCount: number;
  readonly lines: readonly string[] | null;
  readonly startRow: number;
}

export interface DiffSyntaxLocation {
  readonly hunkIndex: number;
  readonly lineIndex: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;
const HUNK_BOUNDARY = /^@@(?:\s|$)/u;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

export class DiffDocument {
  readonly newLineNumberDigits: number;
  readonly oldLineNumberDigits: number;
  readonly stats: DiffStats;
  readonly syntaxHunks: readonly DiffSyntaxHunk[];
  readonly unifiedMaximumColumns: number;
  readonly unifiedRows: readonly UnifiedDiffLine[];
  #splitProjection: SplitDiffProjection | undefined;

  constructor(
    unifiedRows: readonly UnifiedDiffLine[],
    stats: DiffStats,
    unifiedMaximumColumns: number,
    syntaxHunks: readonly DiffSyntaxHunk[],
  ) {
    const lineNumberDigits = measureLineNumberDigits(unifiedRows);
    this.unifiedRows = unifiedRows;
    this.stats = stats;
    this.unifiedMaximumColumns = unifiedMaximumColumns;
    this.syntaxHunks = syntaxHunks;
    this.oldLineNumberDigits = lineNumberDigits.old;
    this.newLineNumberDigits = lineNumberDigits.new;
  }

  splitProjection(): SplitDiffProjection {
    this.#splitProjection ??= projectSplitDiff(this.unifiedRows);
    return this.#splitProjection;
  }

  syntaxLocation(rowIndex: number): DiffSyntaxLocation | null {
    let low = 0;
    let high = this.syntaxHunks.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const hunk = this.syntaxHunks[middle];
      if (hunk === undefined) {
        return null;
      }
      if (rowIndex < hunk.startRow) {
        high = middle - 1;
        continue;
      }
      const lineIndex = rowIndex - hunk.startRow;
      if (lineIndex >= hunk.lineCount) {
        low = middle + 1;
        continue;
      }
      return { hunkIndex: middle, lineIndex };
    }
    return null;
  }
}

export function createDiffDocument(diff: string): DiffDocument {
  const lines = diff.replace(/\r\n?/gu, "\n").split("\n");
  const parsed: UnifiedDiffLine[] = [];
  const syntaxHunks: Array<{
    characterLength: number;
    lineCount: number;
    lines: string[] | null;
    startRow: number;
  }> = [];
  let currentSyntaxHunk:
    | {
        characterLength: number;
        lineCount: number;
        lines: string[] | null;
        startRow: number;
      }
    | undefined;
  let additions = 0;
  let deletions = 0;
  let maximumColumns = 0;
  let oldLine = 1;
  let newLine = 1;
  let sawHunk = false;

  function append(line: UnifiedDiffLine): void {
    parsed.push(line);
    maximumColumns = Math.max(maximumColumns, monospaceColumnCount(line.content));
  }

  function appendContent(line: UnifiedDiffLine): void {
    currentSyntaxHunk ??= {
      characterLength: 0,
      lineCount: 0,
      lines: [],
      startRow: parsed.length,
    };
    if (syntaxHunks.at(-1) !== currentSyntaxHunk) {
      syntaxHunks.push(currentSyntaxHunk);
    }
    currentSyntaxHunk.lineCount += 1;
    currentSyntaxHunk.characterLength += line.content.length + 1;
    if (
      currentSyntaxHunk.lines !== null &&
      currentSyntaxHunk.lineCount <= DIFF_SYNTAX_LIMITS.maximumLines &&
      currentSyntaxHunk.characterLength <= DIFF_SYNTAX_LIMITS.maximumBytes &&
      line.content.length <= DIFF_SYNTAX_LIMITS.maximumLineCharacters
    ) {
      currentSyntaxHunk.lines.push(line.content);
    } else {
      currentSyntaxHunk.lines = null;
    }
    append(line);
  }

  function beginSyntaxHunk(): void {
    currentSyntaxHunk = {
      characterLength: 0,
      lineCount: 0,
      lines: [],
      startRow: parsed.length,
    };
  }

  for (const [index, line] of lines.entries()) {
    if (index === lines.length - 1 && line.length === 0) {
      continue;
    }

    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      const oldStart = hunk[1];
      const newStart = hunk[2];
      if (oldStart === undefined || newStart === undefined) {
        throw new Error("A diff hunk matched without both line-number captures.");
      }
      oldLine = Number(oldStart);
      newLine = Number(newStart);
      sawHunk = true;
      beginSyntaxHunk();
      continue;
    }

    if (HUNK_BOUNDARY.test(line)) {
      sawHunk = true;
      beginSyntaxHunk();
      continue;
    }

    if (!sawHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      continue;
    }

    if (line === NO_NEWLINE_MARKER) {
      continue;
    }
    if (isDiffMetadata(line)) {
      continue;
    }

    if (line.startsWith("+")) {
      additions += 1;
      appendContent({
        content: line.slice(1),
        newNumber: newLine++,
        oldNumber: null,
        type: "addition",
      });
      continue;
    }

    if (line.startsWith("-")) {
      deletions += 1;
      appendContent({
        content: line.slice(1),
        newNumber: null,
        oldNumber: oldLine++,
        type: "deletion",
      });
      continue;
    }

    appendContent({
      content: line.startsWith(" ") ? line.slice(1) : line,
      newNumber: newLine++,
      oldNumber: oldLine++,
      type: "context",
    });
  }

  return new DiffDocument(parsed, { additions, deletions }, maximumColumns, syntaxHunks);
}

export function parseUnifiedDiff(diff: string): readonly UnifiedDiffLine[] {
  return createDiffDocument(diff).unifiedRows;
}

export function parseSplitDiff(diff: string): readonly SplitDiffRow[] {
  return createDiffDocument(diff).splitProjection().rows;
}

export function summarizeDiff(diff: string): DiffStats {
  const lines = diff.replace(/\r\n?/gu, "\n").split("\n");
  let additions = 0;
  let deletions = 0;
  let sawHunk = false;
  for (const [index, line] of lines.entries()) {
    if (index === lines.length - 1 && line.length === 0) {
      continue;
    }
    if (HUNK_BOUNDARY.test(line)) {
      sawHunk = true;
      continue;
    }
    if (!sawHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      continue;
    }
    if (line === NO_NEWLINE_MARKER) {
      continue;
    }
    if (isDiffMetadata(line)) {
      continue;
    }
    additions += Number(line.startsWith("+"));
    deletions += Number(line.startsWith("-"));
  }
  return { additions, deletions };
}

export function countDiffDisplayRows(diff: string, mode: "split" | "unified"): number {
  let additions = 0;
  let deletions = 0;
  let rows = 0;

  function flushChangedLines(): void {
    rows += deletions === 0 ? additions : Math.max(deletions, additions);
    additions = 0;
    deletions = 0;
  }

  visitDiffContentLines(diff, (type) => {
    if (mode === "unified") {
      rows += 1;
      return;
    }
    if (type === "deletion") {
      if (additions > 0) {
        flushChangedLines();
      }
      deletions += 1;
      return;
    }
    if (type === "addition") {
      additions += 1;
      return;
    }
    flushChangedLines();
    rows += 1;
  });
  flushChangedLines();
  return rows;
}

function projectSplitDiff(lines: readonly UnifiedDiffLine[]): SplitDiffProjection {
  const rows: SplitDiffRow[] = [];
  const leftSourceIndexes = new Uint32Array(lines.length);
  const rightSourceIndexes = new Uint32Array(lines.length);
  let index = 0;
  let leftMaximumColumns = 0;
  let rightMaximumColumns = 0;

  function append(
    row: SplitDiffRow,
    leftSourceIndex: number | null,
    rightSourceIndex: number | null,
  ): void {
    const rowIndex = rows.length;
    rows.push(row);
    leftSourceIndexes[rowIndex] = leftSourceIndex === null ? 0 : leftSourceIndex + 1;
    rightSourceIndexes[rowIndex] = rightSourceIndex === null ? 0 : rightSourceIndex + 1;
    leftMaximumColumns = Math.max(leftMaximumColumns, monospaceColumnCount(row.leftContent));
    rightMaximumColumns = Math.max(rightMaximumColumns, monospaceColumnCount(row.rightContent));
  }

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }

    if (line.type === "deletion") {
      const removed: UnifiedDiffLine[] = [];
      const added: UnifiedDiffLine[] = [];
      const removedStartIndex = index;
      while (lines[index]?.type === "deletion") {
        const current = lines[index];
        if (current !== undefined) {
          removed.push(current);
        }
        index += 1;
      }
      const addedStartIndex = index;
      while (lines[index]?.type === "addition") {
        const current = lines[index];
        if (current !== undefined) {
          added.push(current);
        }
        index += 1;
      }
      const rowCount = Math.max(removed.length, added.length);
      for (let pairIndex = 0; pairIndex < rowCount; pairIndex += 1) {
        const left = removed[pairIndex];
        const right = added[pairIndex];
        append(
          {
            leftNumber: left?.oldNumber ?? null,
            leftContent: left?.content ?? "",
            leftType: left === undefined ? "empty" : "removed",
            rightNumber: right?.newNumber ?? null,
            rightContent: right?.content ?? "",
            rightType: right === undefined ? "empty" : "added",
          },
          left === undefined ? null : removedStartIndex + pairIndex,
          right === undefined ? null : addedStartIndex + pairIndex,
        );
      }
      continue;
    }

    if (line.type === "addition") {
      append(
        {
          leftNumber: null,
          leftContent: "",
          leftType: "empty",
          rightNumber: line.newNumber,
          rightContent: line.content,
          rightType: "added",
        },
        null,
        index,
      );
      index += 1;
      continue;
    }

    append(
      {
        leftNumber: line.oldNumber,
        leftContent: line.content,
        leftType: "normal",
        rightNumber: line.newNumber,
        rightContent: line.content,
        rightType: "normal",
      },
      index,
      index,
    );
    index += 1;
  }

  return {
    leftMaximumColumns,
    leftSourceIndexes: leftSourceIndexes.subarray(0, rows.length),
    rightMaximumColumns,
    rightSourceIndexes: rightSourceIndexes.subarray(0, rows.length),
    rows,
  };
}

function measureLineNumberDigits(lines: readonly UnifiedDiffLine[]): {
  readonly new: number;
  readonly old: number;
} {
  let maximumNew = 0;
  let maximumOld = 0;
  for (const line of lines) {
    maximumNew = Math.max(maximumNew, line.newNumber ?? 0);
    maximumOld = Math.max(maximumOld, line.oldNumber ?? 0);
  }
  return {
    new: Math.max(1, String(maximumNew).length),
    old: Math.max(1, String(maximumOld).length),
  };
}

function visitDiffContentLines(diff: string, visit: (type: UnifiedDiffLineType) => void): void {
  let lineStart = 0;
  let sawHunk = false;
  while (lineStart < diff.length) {
    let lineEnd = lineStart;
    while (
      lineEnd < diff.length &&
      diff.charCodeAt(lineEnd) !== 10 &&
      diff.charCodeAt(lineEnd) !== 13
    ) {
      lineEnd += 1;
    }
    const line = diff.slice(lineStart, lineEnd);
    const separator = diff.charCodeAt(lineEnd);
    lineStart = separator === 13 && diff.charCodeAt(lineEnd + 1) === 10 ? lineEnd + 2 : lineEnd + 1;

    if (HUNK_BOUNDARY.test(line)) {
      sawHunk = true;
      continue;
    }
    if (!sawHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      continue;
    }
    if (line === NO_NEWLINE_MARKER || isDiffMetadata(line)) {
      continue;
    }
    visit(line.startsWith("+") ? "addition" : line.startsWith("-") ? "deletion" : "context");
  }
}

function isDiffMetadata(line: string): boolean {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line === "\\ No newline at end of file"
  );
}
