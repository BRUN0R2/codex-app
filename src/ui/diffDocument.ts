export type UnifiedDiffLineType = "addition" | "context" | "deletion" | "hunk" | "meta";

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
  readonly leftType: "removed" | "empty" | "normal" | "header";
  readonly rightNumber: number | null;
  readonly rightContent: string;
  readonly rightType: "added" | "empty" | "normal" | "header";
}

export interface SplitDiffProjection {
  readonly leftMaximumColumns: number;
  readonly rightMaximumColumns: number;
  readonly rows: readonly SplitDiffRow[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;
const TAB_COLUMNS = 4;

export class DiffDocument {
  readonly stats: DiffStats;
  readonly unifiedMaximumColumns: number;
  readonly unifiedRows: readonly UnifiedDiffLine[];
  #splitProjection: SplitDiffProjection | undefined;

  constructor(
    unifiedRows: readonly UnifiedDiffLine[],
    stats: DiffStats,
    unifiedMaximumColumns: number,
  ) {
    this.unifiedRows = unifiedRows;
    this.stats = stats;
    this.unifiedMaximumColumns = unifiedMaximumColumns;
  }

  splitProjection(): SplitDiffProjection {
    this.#splitProjection ??= projectSplitDiff(this.unifiedRows);
    return this.#splitProjection;
  }
}

export function createDiffDocument(diff: string): DiffDocument {
  const lines = diff.replace(/\r\n?/gu, "\n").split("\n");
  const parsed: UnifiedDiffLine[] = [];
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
      append({ content: line, newNumber: null, oldNumber: null, type: "hunk" });
      continue;
    }

    if (!sawHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      continue;
    }

    if (isDiffMetadata(line)) {
      append({ content: line, newNumber: null, oldNumber: null, type: "meta" });
      continue;
    }

    if (line.startsWith("+")) {
      additions += 1;
      append({
        content: line.slice(1),
        newNumber: newLine++,
        oldNumber: null,
        type: "addition",
      });
      continue;
    }

    if (line.startsWith("-")) {
      deletions += 1;
      append({
        content: line.slice(1),
        newNumber: null,
        oldNumber: oldLine++,
        type: "deletion",
      });
      continue;
    }

    append({
      content: line.startsWith(" ") ? line.slice(1) : line,
      newNumber: newLine++,
      oldNumber: oldLine++,
      type: "context",
    });
  }

  return new DiffDocument(parsed, { additions, deletions }, maximumColumns);
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
    if (HUNK_HEADER.test(line)) {
      sawHunk = true;
      continue;
    }
    if (!sawHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
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

export function monospaceColumnCount(value: string): number {
  let columns = 0;
  for (const character of value) {
    columns = character === "\t" ? columns + (TAB_COLUMNS - (columns % TAB_COLUMNS)) : columns + 1;
  }
  return columns;
}

function projectSplitDiff(lines: readonly UnifiedDiffLine[]): SplitDiffProjection {
  const rows: SplitDiffRow[] = [];
  let index = 0;
  let leftMaximumColumns = 0;
  let rightMaximumColumns = 0;

  function append(row: SplitDiffRow): void {
    rows.push(row);
    leftMaximumColumns = Math.max(leftMaximumColumns, monospaceColumnCount(row.leftContent));
    rightMaximumColumns = Math.max(rightMaximumColumns, monospaceColumnCount(row.rightContent));
  }

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }

    if (line.type === "hunk" || line.type === "meta") {
      append({
        leftNumber: null,
        leftContent: line.content,
        leftType: "header",
        rightNumber: null,
        rightContent: line.content,
        rightType: "header",
      });
      index += 1;
      continue;
    }

    if (line.type === "deletion") {
      const removed: UnifiedDiffLine[] = [];
      const added: UnifiedDiffLine[] = [];
      while (lines[index]?.type === "deletion") {
        const current = lines[index];
        if (current !== undefined) {
          removed.push(current);
        }
        index += 1;
      }
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
        append({
          leftNumber: left?.oldNumber ?? null,
          leftContent: left?.content ?? "",
          leftType: left === undefined ? "empty" : "removed",
          rightNumber: right?.newNumber ?? null,
          rightContent: right?.content ?? "",
          rightType: right === undefined ? "empty" : "added",
        });
      }
      continue;
    }

    if (line.type === "addition") {
      append({
        leftNumber: null,
        leftContent: "",
        leftType: "empty",
        rightNumber: line.newNumber,
        rightContent: line.content,
        rightType: "added",
      });
      index += 1;
      continue;
    }

    append({
      leftNumber: line.oldNumber,
      leftContent: line.content,
      leftType: "normal",
      rightNumber: line.newNumber,
      rightContent: line.content,
      rightType: "normal",
    });
    index += 1;
  }

  return { leftMaximumColumns, rightMaximumColumns, rows };
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
