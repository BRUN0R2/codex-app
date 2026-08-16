import type { FileChange, VisibleThreadItem } from "../contracts/types";

export function timelineItemIdentity<T extends Pick<VisibleThreadItem, "id" | "type">>(
  item: T,
): string {
  return `${encodeIdentitySegment(item.type)}${encodeIdentitySegment(item.id)}`;
}

export function timelineItemRenderIdentity(item: VisibleThreadItem): string {
  const identity = timelineItemIdentity(item);
  if (item.type !== "agentMessage") {
    return identity;
  }
  const presentation = item.phase === "commentary" ? "commentary" : "answer";
  return `${identity}${encodeIdentitySegment(presentation)}`;
}

export function timelineFileChangeIdentity(change: FileChange, occurrence: number): string {
  return `${encodeIdentitySegment(change.path)}${occurrence}`;
}

function encodeIdentitySegment(value: string): string {
  return `${value.length}:${value}|`;
}
