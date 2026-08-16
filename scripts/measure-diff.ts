import { performance } from "node:perf_hooks";

import { createDiffDocument, summarizeDiff } from "../src/ui/diffDocument.ts";
import { calculateDiffVirtualRange, DIFF_ROW_HEIGHT_PX } from "../src/ui/diffViewport.ts";
import { highlightCode } from "../src/ui/syntaxHighlight.ts";

const MODIFICATION_COUNT = 50_000;
const VIEWPORT_QUERY_COUNT = 100_000;
const SAMPLE_COUNT = 5;
const diff = createSyntheticDiff(MODIFICATION_COUNT);

const statsMeasurement = measure(() => summarizeDiff(diff));
const documentMeasurement = measure(() => createDiffDocument(diff));
const document = documentMeasurement.value;
const splitProjectionMilliseconds = duration(() => document.splitProjection());
let fullHighlightChecksum = 0;
const fullHighlightMilliseconds = duration(() => {
  for (const row of document.unifiedRows) {
    fullHighlightChecksum += highlightCode(row.content, "ts").length;
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
const visibleHighlightMilliseconds = duration(() => {
  for (const row of representativeRows) {
    visibleHighlightChecksum += highlightCode(row.content, "ts").length;
  }
});

if (
  statsMeasurement.value.additions !== MODIFICATION_COUNT ||
  statsMeasurement.value.deletions !== MODIFICATION_COUNT ||
  document.unifiedRows.length !== MODIFICATION_COUNT * 3 + 1 ||
  document.splitProjection().rows.length !== MODIFICATION_COUNT * 2 + 1 ||
  maximumMountedRows > 74 ||
  viewportChecksum <= 0 ||
  fullHighlightChecksum <= 0 ||
  visibleHighlightChecksum <= 0
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
      documentMedianMs: documentMeasurement.medianMilliseconds,
      splitProjectionMs: roundMilliseconds(splitProjectionMilliseconds),
      fullDocumentHighlightMs: roundMilliseconds(fullHighlightMilliseconds),
      visibleWindowHighlightMs: roundMilliseconds(visibleHighlightMilliseconds),
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
