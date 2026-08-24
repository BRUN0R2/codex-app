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
