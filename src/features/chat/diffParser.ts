export type DiffLineKind = "addition" | "context" | "deletion" | "header";

export interface DiffLine {
  kind: DiffLineKind;
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface DiffStats {
  additions: number;
  deletions: number;
}

export interface DiffSummary extends DiffStats {
  fileCount: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(
  diff: string,
  maximumLines = Number.POSITIVE_INFINITY,
): DiffLine[] {
  if (diff.length === 0) {
    return [];
  }
  const lines: DiffLine[] = [];
  let oldLine: number | null = null;
  let newLine: number | null = null;
  forEachUnifiedDiffLine(diff, (text) => {
    if (lines.length >= maximumLines) {
      return false;
    }
    const hunk = HUNK_HEADER.exec(text);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({ kind: "header", oldLine: null, newLine: null, text });
      return true;
    }
    if (
      oldLine === null ||
      newLine === null ||
      text.startsWith("---") ||
      text.startsWith("+++") ||
      text.startsWith("\\ No newline at end of file")
    ) {
      lines.push({ kind: "header", oldLine: null, newLine: null, text });
      return true;
    }
    if (text.startsWith("+") && !text.startsWith("+++")) {
      lines.push({ kind: "addition", oldLine: null, newLine, text: text.slice(1) });
      if (newLine !== null) {
        newLine += 1;
      }
      return true;
    }
    if (text.startsWith("-") && !text.startsWith("---")) {
      lines.push({ kind: "deletion", oldLine, newLine: null, text: text.slice(1) });
      if (oldLine !== null) {
        oldLine += 1;
      }
      return true;
    }
    const content = text.startsWith(" ") ? text.slice(1) : text;
    lines.push({ kind: "context", oldLine, newLine, text: content });
    if (oldLine !== null) {
      oldLine += 1;
    }
    if (newLine !== null) {
      newLine += 1;
    }
    return true;
  });
  return lines;
}

export function diffStats(diff: string): DiffStats {
  const { additions, deletions } = summarizeUnifiedDiff(diff);
  return { additions, deletions };
}

export function summarizeUnifiedDiff(diff: string): DiffSummary {
  let additions = 0;
  let deletions = 0;
  const gitPaths = new Set<string>();
  const resultingPaths = new Set<string>();
  forEachUnifiedDiffLine(diff, (line) => {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1;
    }
    if (line.startsWith("diff --git a/")) {
      const separator = line.indexOf(" b/");
      if (separator > 13) {
        gitPaths.add(line.slice(13, separator));
      }
    } else if (line.startsWith("+++ ") && line !== "+++ /dev/null") {
      resultingPaths.add(line.slice(4).replace(/^b\//, ""));
    }
    return true;
  });
  return {
    additions,
    deletions,
    fileCount: gitPaths.size > 0 ? gitPaths.size : resultingPaths.size,
  };
}

export function countUnifiedDiffLines(diff: string): number {
  let count = 0;
  forEachUnifiedDiffLine(diff, () => {
    count += 1;
    return true;
  });
  return count;
}

function forEachUnifiedDiffLine(
  diff: string,
  visit: (line: string) => boolean,
) {
  const length = diff.endsWith("\n") ? diff.length - 1 : diff.length;
  let start = 0;
  while (start < length) {
    const separator = diff.indexOf("\n", start);
    const end = separator < 0 || separator > length ? length : separator;
    if (!visit(diff.slice(start, end))) {
      return;
    }
    start = end + 1;
  }
}
