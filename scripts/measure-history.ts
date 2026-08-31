import { performance } from "node:perf_hooks";

import { decodeThreadResumeResponse } from "../src/contracts/decode.ts";

const TURN_COUNT = 741;
const ITEM_COUNT = 15_529;
const TEXT_PAYLOAD_BYTES = 231 * 1_048_576;
const INITIAL_PAGE_ITEMS = 64;
const FULL_SAMPLES = 3;
const PAGE_SAMPLES = 7;
const WARMUP_SAMPLES = 1;

const fullResponse = createConversation();
const initialResponse = createInitialPage(fullResponse, INITIAL_PAGE_ITEMS);
const fullJson = JSON.stringify(fullResponse);
const initialJson = JSON.stringify(initialResponse);

assertConversationShape(fullResponse, TURN_COUNT, ITEM_COUNT);
assertConversationShape(
  initialResponse,
  initialResponse.thread.turns.length,
  INITIAL_PAGE_ITEMS,
);

const fullDecode = measure(
  "full contract decode",
  FULL_SAMPLES,
  () => countItems(decodeThreadResumeResponse(fullResponse)),
);
const initialDecode = measure(
  "initial-page contract decode",
  PAGE_SAMPLES,
  () => countItems(decodeThreadResumeResponse(initialResponse)),
);
const fullParseAndDecode = measure(
  "full JSON parse and contract decode",
  FULL_SAMPLES,
  () => countItems(decodeThreadResumeResponse(JSON.parse(fullJson))),
);
const initialParseAndDecode = measure(
  "initial-page JSON parse and contract decode",
  PAGE_SAMPLES,
  () => countItems(decodeThreadResumeResponse(JSON.parse(initialJson))),
);
const fullRetainedHeap = measureRetainedHeap(fullJson, ITEM_COUNT, FULL_SAMPLES);
const initialRetainedHeap = measureRetainedHeap(
  initialJson,
  INITIAL_PAGE_ITEMS,
  PAGE_SAMPLES,
);

const fullJsonBytes = Buffer.byteLength(fullJson);
const initialJsonBytes = Buffer.byteLength(initialJson);
const reductionPercent = 100 * (1 - INITIAL_PAGE_ITEMS / ITEM_COUNT);
const transportReductionPercent = 100 * (1 - initialJsonBytes / fullJsonBytes);
const retainedHeapReductionPercent =
  100 * (1 - initialRetainedHeap.medianBytes / fullRetainedHeap.medianBytes);

process.stdout.write(
  `${JSON.stringify(
    {
      conversation: {
        turns: TURN_COUNT,
        transcriptItems: ITEM_COUNT,
        textPayloadMiB: round(TEXT_PAYLOAD_BYTES / 1_048_576),
        encodedContractMiB: round(fullJsonBytes / 1_048_576),
      },
      initialPage: {
        transcriptItems: INITIAL_PAGE_ITEMS,
        turnsRepresented: initialResponse.thread.turns.length,
        encodedContractMiB: round(initialJsonBytes / 1_048_576),
        itemReductionPercent: round(reductionPercent),
        transportReductionPercent: round(transportReductionPercent),
        initialRequests: 1,
      },
      contractDecode: {
        fullMedianMs: fullDecode.medianMilliseconds,
        initialPageMedianMs: initialDecode.medianMilliseconds,
        speedup: round(fullDecode.medianMilliseconds / initialDecode.medianMilliseconds),
      },
      parseAndContractDecode: {
        fullMedianMs: fullParseAndDecode.medianMilliseconds,
        initialPageMedianMs: initialParseAndDecode.medianMilliseconds,
        speedup: round(
          fullParseAndDecode.medianMilliseconds / initialParseAndDecode.medianMilliseconds,
        ),
      },
      retainedHeap: {
        fullMedianMiB: round(fullRetainedHeap.medianBytes / 1_048_576),
        initialPageMedianMiB: round(initialRetainedHeap.medianBytes / 1_048_576),
        reductionPercent: round(retainedHeapReductionPercent),
      },
      samples: {
        full: FULL_SAMPLES,
        initialPage: PAGE_SAMPLES,
        warmup: WARMUP_SAMPLES,
      },
    },
    null,
    2,
  )}\n`,
);

function createConversation() {
  const baseTextBytes = Math.floor(TEXT_PAYLOAD_BYTES / ITEM_COUNT);
  const largerTextItems = TEXT_PAYLOAD_BYTES % ITEM_COUNT;
  const baseText = "x".repeat(baseTextBytes);
  const largerText = `${baseText}x`;
  let nextItem = 0;
  const turns = Array.from({ length: TURN_COUNT }, (_, turnIndex) => {
    const itemsInTurn = Math.floor(ITEM_COUNT / TURN_COUNT) + (turnIndex < ITEM_COUNT % TURN_COUNT ? 1 : 0);
    const items = Array.from({ length: itemsInTurn }, (_, itemIndex) => {
      const itemNumber = nextItem;
      nextItem += 1;
      const text = itemNumber < largerTextItems ? largerText : baseText;
      if (itemIndex === 0) {
        return {
          type: "userMessage",
          id: `user-${itemNumber}`,
          content: [{ type: "text", text }],
        };
      }
      return {
        type: "agentMessage",
        id: `agent-${itemNumber}`,
        text,
        phase: "finalAnswer",
      };
    });
    return {
      id: `turn-${turnIndex}`,
      items,
      status: "completed",
      error: null,
      createdAt: turnIndex + 1,
      updatedAt: turnIndex + 1,
    };
  });
  if (nextItem !== ITEM_COUNT) {
    throw new Error(`History benchmark generated ${nextItem} items instead of ${ITEM_COUNT}.`);
  }
  return {
    cwd: "D:\\benchmark",
    nextCursor: null,
    thread: {
      id: "benchmark-thread",
      mode: "codex",
      preview: "Extreme synthetic conversation",
      name: "History benchmark",
      cwd: "D:\\benchmark",
      projectPath: "D:\\benchmark",
      createdAt: 1,
      updatedAt: TURN_COUNT,
      recencyAt: TURN_COUNT,
      status: { type: "idle" },
      turns,
    },
  };
}

function createInitialPage(
  response: ReturnType<typeof createConversation>,
  maximumItems: number,
): ReturnType<typeof createConversation> {
  const newestRows: Array<{
    readonly turn: (typeof response.thread.turns)[number];
    readonly item: (typeof response.thread.turns)[number]["items"][number];
  }> = [];
  for (
    let turnIndex = response.thread.turns.length - 1;
    turnIndex >= 0 && newestRows.length < maximumItems;
    turnIndex -= 1
  ) {
    const turn = response.thread.turns[turnIndex];
    if (turn === undefined) {
      throw new Error("History benchmark could not resolve a turn.");
    }
    for (
      let itemIndex = turn.items.length - 1;
      itemIndex >= 0 && newestRows.length < maximumItems;
      itemIndex -= 1
    ) {
      const item = turn.items[itemIndex];
      if (item === undefined) {
        throw new Error("History benchmark could not resolve a transcript item.");
      }
      newestRows.push({ turn, item });
    }
  }
  newestRows.reverse();

  const turns: typeof response.thread.turns = [];
  for (const row of newestRows) {
    const previous = turns.at(-1);
    if (previous?.id === row.turn.id) {
      previous.items.push(row.item);
      continue;
    }
    turns.push({ ...row.turn, items: [row.item] });
  }

  return {
    ...response,
    nextCursor: "benchmark-cursor",
    thread: { ...response.thread, turns },
  };
}

function measure(
  label: string,
  sampleCount: number,
  operation: () => number,
): { readonly medianMilliseconds: number } {
  const durations: number[] = [];
  let checksum = 0;
  for (let sample = 0; sample < sampleCount + WARMUP_SAMPLES; sample += 1) {
    globalThis.gc?.();
    const startedAt = performance.now();
    const items = operation();
    const elapsed = performance.now() - startedAt;
    if (items <= 0) {
      throw new Error(`${label} produced an invalid item count.`);
    }
    checksum += items;
    if (sample >= WARMUP_SAMPLES) {
      durations.push(elapsed);
    }
  }
  if (checksum <= 0) {
    throw new Error(`${label} produced an invalid checksum.`);
  }
  const sorted = durations.toSorted((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median === undefined) {
    throw new Error(`${label} produced no measurements.`);
  }
  return { medianMilliseconds: round(median) };
}

function assertConversationShape(
  response: ReturnType<typeof createConversation>,
  expectedTurns: number,
  expectedItems: number,
): void {
  if (
    response.thread.turns.length !== expectedTurns ||
    countItems(response) !== expectedItems
  ) {
    throw new Error("History benchmark generated an invalid conversation.");
  }
}

function measureRetainedHeap(
  json: string,
  expectedItems: number,
  sampleCount: number,
): { readonly medianBytes: number } {
  const deltas: number[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    globalThis.gc?.();
    const baseline = process.memoryUsage().heapUsed;
    const parsed: unknown = JSON.parse(json);
    const decoded = decodeThreadResumeResponse(parsed);
    if (countItems(decoded) !== expectedItems) {
      throw new Error("History heap benchmark decoded an invalid item count.");
    }
    deltas.push(Math.max(0, process.memoryUsage().heapUsed - baseline));
  }
  const sorted = deltas.toSorted((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median === undefined) {
    throw new Error("History heap benchmark produced no measurements.");
  }
  return { medianBytes: median };
}

function countItems(response: ReturnType<typeof createConversation>): number {
  return response.thread.turns.reduce((total, turn) => total + turn.items.length, 0);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
