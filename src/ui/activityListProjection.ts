import type { FileChange } from "../contracts/types";
import type { AgentActivityItem } from "./agentActivityPresentation";
import {
  encodeTimelineIdentitySegment,
  timelineFileChangeIdentity,
  timelineItemIdentity,
} from "./timelineIdentity";
import type { VirtualItemSource } from "./variableSizeVirtualizer";

export const COLLAPSED_ACTIVITY_ITEM_ESTIMATE_PX = 26;
export const COLLAPSED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX = 28;
export const EXPANDED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX = 287;
export const EXPANDED_DIFF_ACTIVITY_ITEM_ESTIMATE_PX = 398;

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

const ACTIVITY_PROJECTION_CACHE_CAPACITY = 256;
const ACTIVITY_PROJECTION_CACHE_MASK = ACTIVITY_PROJECTION_CACHE_CAPACITY - 1;

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

  const cachedIndexes = new Int32Array(ACTIVITY_PROJECTION_CACHE_CAPACITY);
  cachedIndexes.fill(-1);
  const cachedEntries = new Array<ActivityListEntry | undefined>(
    ACTIVITY_PROJECTION_CACHE_CAPACITY,
  );
  const cachedKeys = new Array<string | undefined>(ACTIVITY_PROJECTION_CACHE_CAPACITY);

  function keyAt(index: number): string {
    assertActivityListIndex(index, count);
    const cacheIndex = index & ACTIVITY_PROJECTION_CACHE_MASK;
    const cached = cachedIndexes[cacheIndex] === index ? cachedKeys[cacheIndex] : undefined;
    if (cached !== undefined) {
      return cached;
    }
    const segment = segmentAt(segments, index);
    const key =
      segment.kind === "item" ? segment.key : fileChangeEntryKey(segment, index - segment.start);
    cacheProjectionValue(cachedIndexes, cachedKeys, cachedEntries, index, key);
    return key;
  }

  function entryAt(index: number, expectedKey?: string): ActivityListEntry {
    assertActivityListIndex(index, count);
    const cacheIndex = index & ACTIVITY_PROJECTION_CACHE_MASK;
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
    identity: items,
    indexOf(key) {
      for (let cacheIndex = 0; cacheIndex < cachedKeys.length; cacheIndex += 1) {
        if (cachedKeys[cacheIndex] === key) {
          const cachedIndex = cachedIndexes[cacheIndex] ?? -1;
          return cachedIndex < 0 ? null : cachedIndex;
        }
      }
      const segment = findSegmentForKey(segmentsByKeyPrefix, key);
      if (segment === undefined) {
        return null;
      }
      const index = segment.kind === "item" ? segment.start : findFileChangeIndex(segment, key);
      if (index === null) {
        return null;
      }
      cacheProjectionValue(cachedIndexes, cachedKeys, cachedEntries, index, key);
      return index;
    },
    keyAt,
    reuseGroupAt(index) {
      const segment = segmentAt(segments, index);
      return segment.kind === "fileChange" ? segment.kind : segment.item.type;
    },
  };
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

export function estimateActivityListEntrySize(entry: ActivityListEntry, open: boolean): number {
  if (!open) {
    return entry.kind === "fileChange"
      ? COLLAPSED_ACTIVITY_ITEM_ESTIMATE_PX
      : COLLAPSED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX;
  }
  return entry.kind === "fileChange"
    ? EXPANDED_DIFF_ACTIVITY_ITEM_ESTIMATE_PX
    : EXPANDED_OUTPUT_ACTIVITY_ITEM_ESTIMATE_PX;
}

export function activityListEntryReuseGroup(entry: ActivityListEntry): string {
  return entry.kind === "fileChange" ? entry.kind : entry.item.type;
}

function assertActivityListIndex(index: number, count: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error("O índice da entrada virtual de atividade é inválido.");
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
  let occurrence = 0;
  for (let index = 0; index < localIndex; index += 1) {
    if (segment.item.changes[index]?.path === change.path) {
      occurrence += 1;
    }
  }
  const changeIdentity = timelineFileChangeIdentity(change, occurrence);
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
  const occurrenceText = changeIdentity.slice(encodeTimelineIdentitySegment(path).length);
  if (!/^\d+$/u.test(occurrenceText)) {
    return null;
  }
  const expectedOccurrence = Number(occurrenceText);
  let occurrence = 0;
  for (let localIndex = 0; localIndex < segment.item.changes.length; localIndex += 1) {
    if (segment.item.changes[localIndex]?.path !== path) {
      continue;
    }
    if (occurrence === expectedOccurrence) {
      return segment.start + localIndex;
    }
    occurrence += 1;
  }
  return null;
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
  index: number,
  key: string,
): void {
  const cacheIndex = index & ACTIVITY_PROJECTION_CACHE_MASK;
  cachedIndexes[cacheIndex] = index;
  cachedKeys[cacheIndex] = key;
  cachedEntries[cacheIndex] = undefined;
}

function activityListPositionError(key: string): Error {
  return new Error(`A entrada virtual de atividade ${JSON.stringify(key)} perdeu sua posição.`);
}
