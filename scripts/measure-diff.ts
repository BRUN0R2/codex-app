import { performance } from "node:perf_hooks";

import {
  countDiffDisplayRows,
  createDiffDocument,
  summarizeDiff,
} from "../src/ui/diffDocument.ts";
import { calculateDiffVirtualRange, DIFF_ROW_HEIGHT_PX } from "../src/ui/diffViewport.ts";
import type { SyntaxBlock, SyntaxLimits } from "../src/ui/syntax/contracts.ts";
import { DiffSyntaxHighlighter } from "../src/ui/syntax/diffHighlighter.ts";
import { tokenizeSyntaxBlock } from "../src/ui/syntax/tokenizer.ts";

const MODIFICATION_COUNT = 50_000;
const VIEWPORT_QUERY_COUNT = 100_000;
const SAMPLE_COUNT = 5;
const SINGLE_LINE_SYNTAX_LIMITS: SyntaxLimits = {
  maximumBytes: 64 * 1_024,
  maximumLineCharacters: 10_000,
  maximumLines: 1,
};
const diff = createSyntheticDiff(MODIFICATION_COUNT);

const statsMeasurement = measure(() => summarizeDiff(diff));
const unifiedRowCountMeasurement = measure(() => countDiffDisplayRows(diff, "unified"));
const splitRowCountMeasurement = measure(() => countDiffDisplayRows(diff, "split"));
const documentMeasurement = measure(() => createDiffDocument(diff));
const document = documentMeasurement.value;
const splitProjectionMilliseconds = duration(() => document.splitProjection());
let fullHighlightChecksum = 0;
const fullHighlightMilliseconds = duration(() => {
  for (const row of document.unifiedRows) {
    fullHighlightChecksum += tokenCount(
      tokenizeSyntaxBlock(row.content, "typescript", SINGLE_LINE_SYNTAX_LIMITS),
    );
  }
});
let maximumMountedRows = 0;
let viewportChecksum = 0;
const viewportQueriesMilliseconds = duration(() => {
  const maximumScrollTop = Math.max(
    1,
    document.unifiedRows.length * DIFF_ROW_HEIGHT_PX - 900,
  );
  for (let query = 0; query < VIEWPORT_QUERY_COUNT; query += 1) {
    const scrollTop = (query * 104_729) % maximumScrollTop;
    const range = calculateDiffVirtualRange({
      rowCount: document.unifiedRows.length,
      scrollTop,
      viewportHeight: 900,
    });
    maximumMountedRows = Math.max(maximumMountedRows, range.end - range.start);
    viewportChecksum += range.start + range.end;
  }
});
const representativeRange = calculateDiffVirtualRange({
  rowCount: document.unifiedRows.length,
  scrollTop: (document.unifiedRows.length * DIFF_ROW_HEIGHT_PX) / 2,
  viewportHeight: 900,
});
const representativeRows = document.unifiedRows.slice(
  representativeRange.start,
  representativeRange.end,
);
let visibleHighlightChecksum = 0;
const statelessVisibleHighlightMilliseconds = duration(() => {
  for (const row of representativeRows) {
    visibleHighlightChecksum += tokenCount(
      tokenizeSyntaxBlock(row.content, "typescript", SINGLE_LINE_SYNTAX_LIMITS),
    );
  }
});
const representativeDiff = createSyntheticDiff(80);
const representativeDocument = createDiffDocument(representativeDiff);
const representativeSyntaxRange = calculateDiffVirtualRange({
  rowCount: representativeDocument.unifiedRows.length,
  scrollTop: (representativeDocument.unifiedRows.length * DIFF_ROW_HEIGHT_PX) / 2,
  viewportHeight: 900,
});
const representativeSyntaxRows = representativeDocument.unifiedRows.slice(
  representativeSyntaxRange.start,
  representativeSyntaxRange.end,
);
const highlighter = new DiffSyntaxHighlighter();
let statefulHighlightChecksum = 0;
const coldVisibleHighlightMilliseconds = duration(() => {
  for (const [index] of representativeSyntaxRows.entries()) {
    statefulHighlightChecksum +=
      highlighter.render(
        representativeDocument,
        "benchmark.ts",
        representativeSyntaxRange.start + index,
      )?.length ?? 0;
  }
});
const warmVisibleHighlightMilliseconds = duration(() => {
  for (const [index] of representativeSyntaxRows.entries()) {
    statefulHighlightChecksum +=
      highlighter.render(
        representativeDocument,
        "benchmark.ts",
        representativeSyntaxRange.start + index,
      )?.length ?? 0;
  }
});
const largeHunkHighlighter = new DiffSyntaxHighlighter();
const largeHunkFallbackMilliseconds = duration(() => {
  largeHunkHighlighter.render(document, "benchmark.ts", representativeRange.start);
});

if (
  statsMeasurement.value.additions !== MODIFICATION_COUNT ||
  statsMeasurement.value.deletions !== MODIFICATION_COUNT ||
  unifiedRowCountMeasurement.value !== MODIFICATION_COUNT * 3 ||
  splitRowCountMeasurement.value !== MODIFICATION_COUNT * 2 ||
  document.unifiedRows.length !== unifiedRowCountMeasurement.value ||
  document.splitProjection().rows.length !== splitRowCountMeasurement.value ||
  maximumMountedRows > 74 ||
  viewportChecksum <= 0 ||
  fullHighlightChecksum <= 0 ||
  visibleHighlightChecksum <= 0 ||
  statefulHighlightChecksum <= 0
) {
  throw new Error("Diff benchmark violated parsing or virtualization invariants.");
}

process.stdout.write(
  `${JSON.stringify(
    {
      sourceCharacters: diff.length,
      sourceLines: MODIFICATION_COUNT * 3 + 1,
      samples: SAMPLE_COUNT,
      statsMedianMs: statsMeasurement.medianMilliseconds,
      unifiedRowCountMedianMs: unifiedRowCountMeasurement.medianMilliseconds,
      splitRowCountMedianMs: splitRowCountMeasurement.medianMilliseconds,
      documentMedianMs: documentMeasurement.medianMilliseconds,
      splitProjectionMs: roundMilliseconds(splitProjectionMilliseconds),
      fullDocumentHighlightMs: roundMilliseconds(fullHighlightMilliseconds),
      statelessVisibleWindowHighlightMs: roundMilliseconds(statelessVisibleHighlightMilliseconds),
      coldVisibleWindowHighlightMs: roundMilliseconds(coldVisibleHighlightMilliseconds),
      warmVisibleWindowHighlightMs: roundMilliseconds(warmVisibleHighlightMilliseconds),
      largeHunkFallbackMs: roundMilliseconds(largeHunkFallbackMilliseconds),
      representativeHighlightedRows: representativeRows.length,
      viewportQueries: VIEWPORT_QUERY_COUNT,
      viewportQueriesMs: roundMilliseconds(viewportQueriesMilliseconds),
      maximumMountedRows,
      rowMountReduction: roundMilliseconds(document.unifiedRows.length / maximumMountedRows),
    },
    null,
    2,
  )}\n`,
);

function tokenCount(
  result: ReturnType<typeof tokenizeSyntaxBlock>,
): number {
  if (result.kind !== "highlighted") {
    return 0;
  }
  return countBlockTokens(result.lines);
}

function countBlockTokens(block: SyntaxBlock): number {
  let count = 0;
  for (const line of block) {
    count += line.length;
  }
  return count;
}

function createSyntheticDiff(modifications: number): string {
  const lines = [`@@ -1,${modifications * 2} +1,${modifications * 2} @@`];
  for (let index = 0; index < modifications; index += 1) {
    lines.push(`-const before${index} = ${index};`);
    lines.push(`+const after${index} = ${index + 1};`);
    lines.push(` contextCall(${index});`);
  }
  return lines.join("\n");
}

function measure<T>(operation: () => T): {
  readonly medianMilliseconds: number;
  readonly value: T;
} {
  const durations: number[] = [];
  let value = operation();
  for (let sample = 0; sample < SAMPLE_COUNT + 2; sample += 1) {
    const startedAt = performance.now();
    value = operation();
    const elapsed = performance.now() - startedAt;
    if (sample >= 2) {
      durations.push(elapsed);
    }
  }
  const sorted = durations.toSorted((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median === undefined) {
    throw new Error("Diff benchmark produced no samples.");
  }
  return { medianMilliseconds: roundMilliseconds(median), value };
}

function duration(operation: () => void): number {
  const startedAt = performance.now();
  operation();
  return performance.now() - startedAt;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
