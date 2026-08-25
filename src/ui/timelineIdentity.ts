import type { FileChange, VisibleThreadItem } from "../contracts/types";

export function timelineItemIdentity<T extends Pick<VisibleThreadItem, "id" | "type">>(
  item: T,
): string {
  return `${encodeTimelineIdentitySegment(item.type)}${encodeTimelineIdentitySegment(item.id)}`;
}

export function timelineItemRenderIdentity(item: VisibleThreadItem): string {
  const identity = timelineItemIdentity(item);
  if (item.type !== "agentMessage") {
    return identity;
  }
  const presentation = item.phase === "commentary" ? "commentary" : "answer";
  return `${identity}${encodeTimelineIdentitySegment(presentation)}`;
}

export function timelineFileChangeIdentity(change: FileChange, occurrence: number): string {
  return `${encodeTimelineIdentitySegment(change.path)}${occurrence}`;
}

export function encodeTimelineIdentitySegment(value: string): string {
  return `${value.length}:${value}|`;
}

export function timelineIdentityPrefixes(identity: string): readonly string[] {
  const prefixes: string[] = [];
  let cursor = 0;
  while (cursor < identity.length) {
    const separator = identity.indexOf(":", cursor);
    if (separator < 0) {
      throw new Error("Timeline identity is missing a segment length separator.");
    }
    const lengthText = identity.slice(cursor, separator);
    if (!/^\d+$/u.test(lengthText)) {
      throw new Error("Timeline identity contains an invalid segment length.");
    }
    const segmentLength = Number(lengthText);
    const segmentEnd = separator + 1 + segmentLength;
    if (!Number.isSafeInteger(segmentLength) || identity[segmentEnd] !== "|") {
      throw new Error("Timeline identity contains an incomplete segment.");
    }
    cursor = segmentEnd + 1;
    prefixes.push(identity.slice(0, cursor));
  }
  return prefixes;
}
