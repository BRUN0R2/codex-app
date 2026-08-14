import { performance } from "node:perf_hooks";

import { overlayVisibleTurn } from "../src/state/visibleTurnSequence.ts";
import { createMarkdownStreamRenderer } from "../src/ui/markdownStreamRenderer.ts";
import { VariableSizeVirtualizer } from "../src/ui/variableSizeVirtualizer.ts";

const TURN_COUNT = 100_000;
const RANGE_QUERY_COUNT = 50_000;
const MEASUREMENT_COUNT = 10_000;
const OVERLAY_PROJECTION_COUNT = 50_000;
const MARKDOWN_BLOCK_COUNT = 5_000;
const ESTIMATED_TURN_HEIGHT = 498;

const keys = Array.from({ length: TURN_COUNT }, (_, index) => `turn-${index}`);
const virtualizer = new VariableSizeVirtualizer(ESTIMATED_TURN_HEIGHT);
const buildMilliseconds = duration(() => virtualizer.setKeys(keys));
const measurementMilliseconds = duration(() => {
  for (let index = 0; index < MEASUREMENT_COUNT; index += 1) {
    const key = keys[index];
    if (key === undefined) {
      throw new Error("Soak benchmark could not resolve a measured turn.");
    }
    virtualizer.measure(key, 320 + (index % 17) * 23);
  }
});
let maximumRenderedTurns = 0;
let rangeChecksum = 0;
const rangeQueryMilliseconds = duration(() => {
  const maximumOffset = Math.max(1, virtualizer.totalSize() - 900);
  for (let query = 0; query < RANGE_QUERY_COUNT; query += 1) {
    const offset = (query * 104_729) % maximumOffset;
    const range = virtualizer.range(offset, 900, 900);
    maximumRenderedTurns = Math.max(maximumRenderedTurns, range.end - range.start);
    rangeChecksum += range.start + range.end;
  }
});

const persistedTurns = keys.map((id, index) => ({
  id,
  items: [],
  status: "completed" as const,
  error: null,
  createdAt: index,
  updatedAt: index,
}));
const lastPersistedTurn = persistedTurns.at(-1);
if (lastPersistedTurn === undefined) {
  throw new Error("Soak benchmark requires at least one persisted turn.");
}
const overlayTurn = {
  ...lastPersistedTurn,
  status: "inProgress" as const,
  items: [{ type: "agentMessage" as const, id: "streaming", text: "partial", phase: null }],
};
let overlayChecksum = 0;
const overlayProjectionMilliseconds = duration(() => {
  for (let index = 0; index < OVERLAY_PROJECTION_COUNT; index += 1) {
    const sequence = overlayVisibleTurn(persistedTurns, TURN_COUNT - 1, overlayTurn);
    overlayChecksum += sequence.slice(-8).length;
  }
});

const markdown = createMarkdownStreamRenderer((source) => source);
let markdownSource = "";
let committedCharacters = 0;
const markdownMilliseconds = duration(() => {
  for (let index = 0; index < MARKDOWN_BLOCK_COUNT; index += 1) {
    markdownSource += `${index === 0 ? "" : "\n\n"}Paragraph ${index}.`;
    const update = markdown.render(markdownSource, true);
    committedCharacters += update.appendHtml.length;
  }
  const completed = markdown.render(markdownSource, false);
  if (completed.appendHtml.length !== markdownSource.length) {
    throw new Error("Markdown soak benchmark lost content during finalization.");
  }
});

if (
  maximumRenderedTurns > 16 ||
  rangeChecksum <= 0 ||
  overlayChecksum !== OVERLAY_PROJECTION_COUNT * 8 ||
  committedCharacters <= 0
) {
  throw new Error("Soak benchmark violated a virtualization or streaming invariant.");
}

process.stdout.write(
  `${JSON.stringify(
    {
      turnCount: TURN_COUNT,
      measuredTurns: MEASUREMENT_COUNT,
      rangeQueries: RANGE_QUERY_COUNT,
      maximumRenderedTurns,
      virtualizerBuildMs: roundMilliseconds(buildMilliseconds),
      virtualizerMeasurementsMs: roundMilliseconds(measurementMilliseconds),
      virtualizerQueriesMs: roundMilliseconds(rangeQueryMilliseconds),
      overlayProjections: OVERLAY_PROJECTION_COUNT,
      overlayProjectionMs: roundMilliseconds(overlayProjectionMilliseconds),
      markdownBlocks: MARKDOWN_BLOCK_COUNT,
      incrementalMarkdownMs: roundMilliseconds(markdownMilliseconds),
    },
    null,
    2,
  )}\n`,
);

function duration(operation: () => void): number {
  const startedAt = performance.now();
  operation();
  return performance.now() - startedAt;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
