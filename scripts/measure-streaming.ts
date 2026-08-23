import { performance } from "node:perf_hooks";

import type { VisibleThreadItem } from "../src/contracts/types.ts";
import { applyStreamDeltas } from "../src/state/conversation.ts";
import type { StreamDelta } from "../src/state/streamDeltas.ts";

const ITEM_COUNT: number = 20_000;
const DELTA_COUNT: number = 1_200;
const COMMAND_DELTA_BYTES: number = 2_048;
const COMMAND_DELTA_COUNT: number = 128;
const SAMPLE_COUNT: number = 7;
const TARGET_ITEM_ID = `message-${ITEM_COUNT - 1}`;
const TARGET_COMMAND_ID = "command-live-output";

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
const commandInitialItems: readonly VisibleThreadItem[] = [
  ...initialItems.slice(0, -1),
  {
    type: "commandExecution",
    id: TARGET_COMMAND_ID,
    command: "pnpm build",
    cwd: ".",
    processId: null,
    startedAt: 1,
    source: "agent",
    status: "inProgress",
    aggregatedOutput: null,
    liveOutput: { stdout: "", stderr: "", truncated: false },
    exitCode: null,
    durationMs: null,
  },
];
const commandChunk = "x".repeat(COMMAND_DELTA_BYTES);
const commandDeltas: readonly StreamDelta[] = Array.from(
  { length: COMMAND_DELTA_COUNT },
  () => ({
    kind: "commandOutput",
    threadId: "benchmark-thread",
    itemId: TARGET_COMMAND_ID,
    stream: "stdout",
    operation: { type: "append", delta: commandChunk },
  }),
);

const sequential = measure(() => {
  let items = initialItems;
  for (const delta of deltas) {
    items = applyStreamDeltas(items, [delta]);
  }
  return readTargetLength(items);
}, DELTA_COUNT);
const batched = measure(
  () => readTargetLength(applyStreamDeltas(initialItems, deltas)),
  DELTA_COUNT,
);
const speedup = sequential.medianMilliseconds / batched.medianMilliseconds;
const commandSequential = measure(() => {
  let items = commandInitialItems;
  for (const delta of commandDeltas) {
    items = applyStreamDeltas(items, [delta]);
  }
  return readCommandLength(items);
}, COMMAND_DELTA_BYTES * COMMAND_DELTA_COUNT);
const commandFramed = measure(() => {
  const first = commandDeltas[0];
  if (first === undefined) {
    throw new Error("Command streaming benchmark has no leading delta.");
  }
  let items = applyStreamDeltas(commandInitialItems, [first]);
  items = applyStreamDeltas(items, [
    {
      ...first,
      operation: {
        type: "append",
        delta: commandChunk.repeat(COMMAND_DELTA_COUNT - 1),
      },
    },
  ]);
  return readCommandLength(items);
}, COMMAND_DELTA_BYTES * COMMAND_DELTA_COUNT);
const commandSpeedup =
  commandSequential.medianMilliseconds / commandFramed.medianMilliseconds;

if (speedup < 2) {
  throw new Error(
    `Streaming batching regressed below the required 2x speedup: ${speedup.toFixed(3)}x.`,
  );
}
if (commandSpeedup < 2) {
  throw new Error(
    `Command output framing regressed below the required 2x speedup: ${commandSpeedup.toFixed(3)}x.`,
  );
}

process.stdout.write(
  `${JSON.stringify(
    {
      samples: SAMPLE_COUNT,
      agentText: {
        itemCount: ITEM_COUNT,
        deltaCount: DELTA_COUNT,
        sequentialMedianMs: sequential.medianMilliseconds,
        batchedMedianMs: batched.medianMilliseconds,
        speedup,
      },
      commandOutput: {
        itemCount: ITEM_COUNT,
        deltaCount: COMMAND_DELTA_COUNT,
        outputBytes: COMMAND_DELTA_BYTES * COMMAND_DELTA_COUNT,
        sequentialMedianMs: commandSequential.medianMilliseconds,
        framedMedianMs: commandFramed.medianMilliseconds,
        speedup: commandSpeedup,
      },
    },
    null,
    2,
  )}\n`,
);

function measure(operation: () => number, expectedChecksumPerRun: number): {
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
  if (checksum !== expectedChecksumPerRun * (SAMPLE_COUNT + 2)) {
    throw new Error(`Streaming benchmark produced an invalid checksum: ${checksum}`);
  }
  const sorted = durations.toSorted((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median === undefined) {
    throw new Error("Streaming benchmark produced no samples.");
  }
  return { medianMilliseconds: roundMilliseconds(median) };
}

function readCommandLength(items: readonly VisibleThreadItem[]): number {
  const target = items.at(-1);
  if (
    target?.type !== "commandExecution" ||
    target.id !== TARGET_COMMAND_ID ||
    target.liveOutput === null
  ) {
    throw new Error("Streaming benchmark lost its target command.");
  }
  return target.liveOutput.stdout.length;
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
