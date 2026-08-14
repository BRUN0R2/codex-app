import { performance } from "node:perf_hooks";

import type { VisibleThreadItem } from "../src/contracts/types.ts";
import { appendAgentText, applyStreamDeltas } from "../src/state/conversation.ts";
import type { StreamDelta } from "../src/state/streamDeltas.ts";

const ITEM_COUNT = 20_000;
const DELTA_COUNT = 1_200;
const SAMPLE_COUNT = 7;
const TARGET_ITEM_ID = `message-${ITEM_COUNT - 1}`;

const initialItems: readonly VisibleThreadItem[] = Array.from(
  { length: ITEM_COUNT },
  (_, index) => ({
    type: "agentMessage",
    id: `message-${index}`,
    text: "",
    phase: null,
  }),
);
const deltas: readonly StreamDelta[] = Array.from({ length: DELTA_COUNT }, () => ({
  kind: "agentText",
  threadId: "benchmark-thread",
  itemId: TARGET_ITEM_ID,
  delta: "x",
}));

const sequential = measure(() => {
  let items = initialItems;
  for (const delta of deltas) {
    items = appendAgentText(items, delta.itemId, delta.delta);
  }
  return readTargetLength(items);
});
const batched = measure(() => readTargetLength(applyStreamDeltas(initialItems, deltas)));

process.stdout.write(
  `${JSON.stringify(
    {
      itemCount: ITEM_COUNT,
      deltaCount: DELTA_COUNT,
      samples: SAMPLE_COUNT,
      sequentialMedianMs: sequential.medianMilliseconds,
      batchedMedianMs: batched.medianMilliseconds,
      speedup: sequential.medianMilliseconds / batched.medianMilliseconds,
    },
    null,
    2,
  )}\n`,
);

function measure(operation: () => number): {
  readonly medianMilliseconds: number;
} {
  const durations: number[] = [];
  let checksum = 0;
  for (let sample = 0; sample < SAMPLE_COUNT + 2; sample += 1) {
    const startedAt = performance.now();
    checksum += operation();
    const duration = performance.now() - startedAt;
    if (sample >= 2) {
      durations.push(duration);
    }
  }
  if (checksum !== DELTA_COUNT * (SAMPLE_COUNT + 2)) {
    throw new Error(`Streaming benchmark produced an invalid checksum: ${checksum}`);
  }
  const sorted = durations.toSorted((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median === undefined) {
    throw new Error("Streaming benchmark produced no samples.");
  }
  return { medianMilliseconds: roundMilliseconds(median) };
}

function readTargetLength(items: readonly VisibleThreadItem[]): number {
  const target = items.at(-1);
  if (target?.type !== "agentMessage" || target.id !== TARGET_ITEM_ID) {
    throw new Error("Streaming benchmark lost its target message.");
  }
  return target.text.length;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
