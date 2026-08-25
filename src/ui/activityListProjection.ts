import type { FileChange } from "../contracts/types";
import type { AgentActivityItem } from "./agentActivityPresentation";
import { countDiffDisplayRows } from "./diffDocument";
import { DIFF_ROW_HEIGHT_PX, DIFF_VIEWPORT_MAX_HEIGHT_PX } from "./diffViewport";
import {
  encodeTimelineIdentitySegment,
  timelineFileChangeIdentity,
  timelineItemIdentity,
} from "./timelineIdentity";
import { splitOutputLines } from "./toolOutputProjection";
import type { VirtualItemSource } from "./variableSizeVirtualizer";

export const COLLAPSED_ACTIVITY_ITEM_ESTIMATE_PX = 27;
export const COLLAPSED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX = 28;
export const EXPANDED_OUTPUT_ACTIVITY_CHROME_HEIGHT_PX = 82;
export const EXPANDED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX = 287;
export const EXPANDED_DIFF_ACTIVITY_CHROME_HEIGHT_PX = 71;
export const MAXIMUM_EXPANDED_DIFF_ACTIVITY_ITEM_ESTIMATE_PX =
  EXPANDED_DIFF_ACTIVITY_CHROME_HEIGHT_PX + DIFF_VIEWPORT_MAX_HEIGHT_PX;

export type ActivityListEntry =
  | {
      readonly change: FileChange;
      readonly key: string;
      readonly kind: "fileChange";
    }
  | {
      readonly item: Exclude<AgentActivityItem, { readonly type: "fileChange" }>;
      readonly key: string;
      readonly kind: "item";
    };

export interface ActivityListProjection extends VirtualItemSource {
  readonly entryAt: (index: number, expectedKey?: string) => ActivityListEntry;
  readonly fileChangeAt: (index: number, expectedKey?: string) => FileChange;
  readonly itemAt: (
    index: number,
    expectedKey?: string,
  ) => Exclude<AgentActivityItem, { readonly type: "fileChange" }>;
  readonly kindAt: (index: number) => ActivityListEntry["kind"];
  readonly reuseGroupAt: (index: number) => string;
}

type ActivityListSegment =
  | {
      readonly collapsedOffset: number;
      readonly end: number;
      readonly item: Exclude<AgentActivityItem, { readonly type: "fileChange" }>;
      readonly key: string;
      readonly kind: "item";
      readonly start: number;
    }
  | {
      readonly collapsedOffset: number;
      readonly end: number;
      readonly item: Extract<AgentActivityItem, { readonly type: "fileChange" }>;
      readonly keyPrefix: string;
      readonly kind: "fileChange";
      readonly start: number;
    };

const DEFAULT_ACTIVITY_PROJECTION_CACHE_CAPACITY = 256;
const EXTREME_ACTIVITY_PROJECTION_ITEM_THRESHOLD = 4_096;
const MINIMUM_EXTREME_ACTIVITY_PROJECTION_CACHE_CAPACITY = 8_192;
const MAXIMUM_EXTREME_ACTIVITY_PROJECTION_CACHE_CAPACITY = 131_072;
const RECENT_ACTIVITY_PROJECTION_REVERSE_INDEX_CAPACITY = 512;

export function createActivityListProjection(
  items: readonly AgentActivityItem[],
): ActivityListProjection {
  const segments: ActivityListSegment[] = [];
  const segmentsByKeyPrefix = new Map<string, ActivityListSegment>();
  let count = 0;
  let collapsedSize = 0;
  for (const item of items) {
    const key = timelineItemIdentity(item);
    const segment: ActivityListSegment =
      item.type === "fileChange"
        ? {
            collapsedOffset: collapsedSize,
            end: count + item.changes.length,
            item,
            keyPrefix: key,
            kind: "fileChange",
            start: count,
          }
        : {
            collapsedOffset: collapsedSize,
            end: count + 1,
            item,
            key,
            kind: "item",
            start: count,
          };
    if (segmentsByKeyPrefix.has(key)) {
      throw new Error(`A projeção de atividade produziu a chave duplicada ${JSON.stringify(key)}.`);
    }
    segments.push(segment);
    segmentsByKeyPrefix.set(key, segment);
    count = segment.end;
    collapsedSize +=
      (segment.end - segment.start) *
      (segment.kind === "fileChange"
        ? COLLAPSED_ACTIVITY_ITEM_ESTIMATE_PX
        : COLLAPSED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX);
  }

  const cacheCapacity = activityProjectionCacheCapacity(count);
  const cacheMask = cacheCapacity - 1;
  const cachedIndexes = new Int32Array(cacheCapacity);
  cachedIndexes.fill(-1);
  const cachedEntries = new Array<ActivityListEntry | undefined>(cacheCapacity);
  const cachedKeys = new Array<string | undefined>(cacheCapacity);
  const cachedIndexesByKey = new Map<string, number>();

  function keyAt(index: number): string {
    assertActivityListIndex(index, count);
    const cacheIndex = index & cacheMask;
    const cached = cachedIndexes[cacheIndex] === index ? cachedKeys[cacheIndex] : undefined;
    if (cached !== undefined) {
      return cached;
    }
    const segment = segmentAt(segments, index);
    const key =
      segment.kind === "item" ? segment.key : fileChangeEntryKey(segment, index - segment.start);
    cacheProjectionValue(cachedIndexes, cachedKeys, cachedEntries, cachedIndexesByKey, index, key);
    return key;
  }

  function entryAt(index: number, expectedKey?: string): ActivityListEntry {
    assertActivityListIndex(index, count);
    const cacheIndex = index & cacheMask;
    const cached = cachedIndexes[cacheIndex] === index ? cachedEntries[cacheIndex] : undefined;
    if (cached !== undefined) {
      if (expectedKey !== undefined && cached.key !== expectedKey) {
        throw activityListPositionError(expectedKey);
      }
      return cached;
    }
    const segment = segmentAt(segments, index);
    const key = keyAt(index);
    if (expectedKey !== undefined && key !== expectedKey) {
      throw activityListPositionError(expectedKey);
    }
    const entry: ActivityListEntry =
      segment.kind === "fileChange"
        ? {
            change: readFileChange(segment, index - segment.start),
            key,
            kind: "fileChange",
          }
        : { item: segment.item, key, kind: "item" };
    cachedEntries[cacheIndex] = entry;
    return entry;
  }

  return {
    count,
    entryAt,
    estimatedOffsetOf(index) {
      if (!Number.isInteger(index) || index < 0 || index > count) {
        throw new Error("O deslocamento virtual de atividade é inválido.");
      }
      if (index === count) {
        return collapsedSize;
      }
      const segment = segmentAt(segments, index);
      const itemSize =
        segment.kind === "fileChange"
          ? COLLAPSED_ACTIVITY_ITEM_ESTIMATE_PX
          : COLLAPSED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX;
      return segment.collapsedOffset + (index - segment.start) * itemSize;
    },
    estimatedSizeAt(index) {
      const segment = segmentAt(segments, index);
      return segment.kind === "fileChange"
        ? COLLAPSED_ACTIVITY_ITEM_ESTIMATE_PX
        : COLLAPSED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX;
    },
    fileChangeAt(index, expectedKey) {
      assertExpectedActivityListKey(index, count, keyAt, expectedKey);
      const segment = segmentAt(segments, index);
      if (segment.kind !== "fileChange") {
        throw new Error("A entrada virtualizada não contém uma alteração de arquivo.");
      }
      return readFileChange(segment, index - segment.start);
    },
    identity: items,
    indexOf(key) {
      const cachedIndex = cachedIndexesByKey.get(key);
      if (cachedIndex !== undefined) {
        return cachedIndex;
      }
      const segment = findSegmentForKey(segmentsByKeyPrefix, key);
      if (segment === undefined) {
        return null;
      }
      const index = segment.kind === "item" ? segment.start : findFileChangeIndex(segment, key);
      if (index === null) {
        return null;
      }
      cacheProjectionValue(
        cachedIndexes,
        cachedKeys,
        cachedEntries,
        cachedIndexesByKey,
        index,
        key,
      );
      return index;
    },
    itemAt(index, expectedKey) {
      assertExpectedActivityListKey(index, count, keyAt, expectedKey);
      const segment = segmentAt(segments, index);
      if (segment.kind !== "item") {
        throw new Error("A entrada virtualizada não contém uma atividade executável.");
      }
      return segment.item;
    },
    keyAt,
    kindAt(index) {
      assertActivityListIndex(index, count);
      return segmentAt(segments, index).kind;
    },
    reuseGroupAt(index) {
      const segment = segmentAt(segments, index);
      return segment.kind === "fileChange" ? segment.kind : activityItemReuseGroup(segment.item);
    },
  };
}

function activityProjectionCacheCapacity(itemCount: number): number {
  if (itemCount < EXTREME_ACTIVITY_PROJECTION_ITEM_THRESHOLD) {
    return DEFAULT_ACTIVITY_PROJECTION_CACHE_CAPACITY;
  }
  let capacity = MINIMUM_EXTREME_ACTIVITY_PROJECTION_CACHE_CAPACITY;
  while (capacity < itemCount && capacity < MAXIMUM_EXTREME_ACTIVITY_PROJECTION_CACHE_CAPACITY) {
    capacity *= 2;
  }
  return capacity;
}

export function projectActivityListEntries(
  items: readonly AgentActivityItem[],
): readonly ActivityListEntry[] {
  const projection = createActivityListProjection(items);
  return Array.from({ length: projection.count }, (_, index) => projection.entryAt(index));
}

export function activityListEntryDisclosureKey(entry: ActivityListEntry): string {
  if (entry.kind === "fileChange") {
    return entry.key;
  }
  return `${entry.item.type === "commandExecution" ? "command" : "tool"}:${entry.item.id}`;
}

export function estimateActivityListEntrySize(
  entry: ActivityListEntry,
  open: boolean,
  diffDisplay: "split" | "unified" = "unified",
): number {
  if (!open) {
    return entry.kind === "fileChange"
      ? COLLAPSED_ACTIVITY_ITEM_ESTIMATE_PX
      : COLLAPSED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX;
  }
  return entry.kind === "fileChange"
    ? estimateExpandedDiffActivityItemSize(entry.change, diffDisplay)
    : estimateExpandedOutputActivityItemSize(entry.item);
}

export function estimateExpandedDiffActivityItemSize(
  change: FileChange,
  diffDisplay: "split" | "unified",
): number {
  const visibleRows = Math.min(
    countDiffDisplayRows(change.diff, diffDisplay),
    DIFF_VIEWPORT_MAX_HEIGHT_PX / DIFF_ROW_HEIGHT_PX,
  );
  return EXPANDED_DIFF_ACTIVITY_CHROME_HEIGHT_PX + visibleRows * DIFF_ROW_HEIGHT_PX;
}

function estimateExpandedOutputActivityItemSize(
  item: Exclude<AgentActivityItem, { readonly type: "fileChange" }>,
): number {
  const failureFooterHeight =
    item.type !== "toolExecution" && item.type !== "commandExecution"
      ? 0
      : item.status === "failed" || item.status === "declined"
        ? 23
        : 0;
  if (item.type !== "toolExecution") {
    return EXPANDED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX + failureFooterHeight;
  }
  const output = item.output;
  if (output === null || output.preview.length === 0) {
    return EXPANDED_OUTPUT_ACTIVITY_CHROME_HEIGHT_PX + failureFooterHeight;
  }
  switch (item.outputPresentation.type) {
    case "fileList":
    case "searchResults":
    case "sourceFile": {
      const paginationHeight = output.nextCursor === null ? 0 : 32;
      const contentHeight = splitOutputLines(output.preview).length * 22 + paginationHeight;
      return (
        EXPANDED_OUTPUT_ACTIVITY_CHROME_HEIGHT_PX +
        Math.min(
          EXPANDED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX - EXPANDED_OUTPUT_ACTIVITY_CHROME_HEIGHT_PX,
          contentHeight,
        ) +
        failureFooterHeight
      );
    }
    case "image":
    case "plainText":
      return EXPANDED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX + failureFooterHeight;
  }
}

export function activityListEntryReuseGroup(entry: ActivityListEntry): string {
  return entry.kind === "fileChange" ? entry.kind : activityItemReuseGroup(entry.item);
}

function activityItemReuseGroup(
  item: Exclude<AgentActivityItem, { readonly type: "fileChange" }>,
): string {
  return item.type === "toolExecution" ? `${item.type}:${item.outputPresentation.type}` : item.type;
}

function assertActivityListIndex(index: number, count: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error("O índice da entrada virtual de atividade é inválido.");
  }
}

function assertExpectedActivityListKey(
  index: number,
  count: number,
  keyAt: (index: number) => string,
  expectedKey: string | undefined,
): void {
  assertActivityListIndex(index, count);
  if (expectedKey !== undefined && keyAt(index) !== expectedKey) {
    throw activityListPositionError(expectedKey);
  }
}

function segmentAt(segments: readonly ActivityListSegment[], index: number): ActivityListSegment {
  let start = 0;
  let end = segments.length;
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2);
    const segment = segments[middle];
    if (segment === undefined) {
      break;
    }
    if (index < segment.start) {
      end = middle;
    } else if (index >= segment.end) {
      start = middle + 1;
    } else {
      return segment;
    }
  }
  throw new Error("A projeção virtual de atividade não contém o índice solicitado.");
}

function readFileChange(
  segment: Extract<ActivityListSegment, { readonly kind: "fileChange" }>,
  localIndex: number,
): FileChange {
  const change = segment.item.changes[localIndex];
  if (change === undefined) {
    throw new Error("A projeção virtual perdeu uma alteração de arquivo.");
  }
  return change;
}

function fileChangeEntryKey(
  segment: Extract<ActivityListSegment, { readonly kind: "fileChange" }>,
  localIndex: number,
): string {
  const change = readFileChange(segment, localIndex);
  const changeIdentity = timelineFileChangeIdentity(change, localIndex);
  return `${segment.keyPrefix}${encodeTimelineIdentitySegment(changeIdentity)}`;
}

function findSegmentForKey(
  segmentsByKeyPrefix: ReadonlyMap<string, ActivityListSegment>,
  key: string,
): ActivityListSegment | undefined {
  for (const [prefix, segment] of segmentsByKeyPrefix) {
    if (key.startsWith(prefix)) {
      return segment;
    }
  }
  return undefined;
}

function findFileChangeIndex(
  segment: Extract<ActivityListSegment, { readonly kind: "fileChange" }>,
  key: string,
): number | null {
  const encodedIdentity = key.slice(segment.keyPrefix.length);
  const changeIdentity = decodeIdentitySegment(encodedIdentity);
  if (changeIdentity === null) {
    return null;
  }
  const path = decodeIdentitySegment(changeIdentity);
  if (path === null) {
    return null;
  }
  const ordinalText = changeIdentity.slice(encodeTimelineIdentitySegment(path).length);
  if (!/^\d+$/u.test(ordinalText)) {
    return null;
  }
  const ordinal = Number(ordinalText);
  return Number.isSafeInteger(ordinal) && segment.item.changes[ordinal]?.path === path
    ? segment.start + ordinal
    : null;
}

function decodeIdentitySegment(value: string): string | null {
  const separator = value.indexOf(":");
  if (separator < 1) {
    return null;
  }
  const lengthText = value.slice(0, separator);
  if (!/^\d+$/u.test(lengthText)) {
    return null;
  }
  const length = Number(lengthText);
  const start = separator + 1;
  const end = start + length;
  return Number.isSafeInteger(length) && value[end] === "|" ? value.slice(start, end) : null;
}

function cacheProjectionValue(
  cachedIndexes: Int32Array,
  cachedKeys: Array<string | undefined>,
  cachedEntries: Array<ActivityListEntry | undefined>,
  cachedIndexesByKey: Map<string, number>,
  index: number,
  key: string,
): void {
  const cacheIndex = index & (cachedIndexes.length - 1);
  cachedIndexes[cacheIndex] = index;
  cachedKeys[cacheIndex] = key;
  cachedEntries[cacheIndex] = undefined;
  if (
    !cachedIndexesByKey.has(key) &&
    cachedIndexesByKey.size >= RECENT_ACTIVITY_PROJECTION_REVERSE_INDEX_CAPACITY
  ) {
    const oldestKey = cachedIndexesByKey.keys().next().value;
    if (oldestKey !== undefined) {
      cachedIndexesByKey.delete(oldestKey);
    }
  }
  cachedIndexesByKey.set(key, index);
}

function activityListPositionError(key: string): Error {
  return new Error(`A entrada virtual de atividade ${JSON.stringify(key)} perdeu sua posição.`);
}
