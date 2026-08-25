import { describe, expect, it } from "vitest";

import type { VisibleThreadItem } from "../contracts/types";
import {
  encodeTimelineIdentitySegment,
  timelineFileChangeIdentity,
  timelineIdentityPrefixes,
  timelineItemIdentity,
  timelineItemRenderIdentity,
} from "./timelineIdentity";

describe("timeline render identity", () => {
  it("survives immutable item updates without confusing different item types", () => {
    const message: VisibleThreadItem = {
      type: "agentMessage",
      id: "message-1",
      text: "a",
      phase: "commentary",
    };

    expect(timelineItemIdentity({ ...message, text: "ab" })).toBe(timelineItemIdentity(message));
    expect(
      timelineItemIdentity({
        type: "userMessage",
        id: message.id,
        content: [{ type: "text", text: "mensagem" }],
      }),
    ).not.toBe(timelineItemIdentity(message));
  });

  it("recreates only the message presentation when its semantic lane changes", () => {
    const message: Extract<VisibleThreadItem, { type: "agentMessage" }> = {
      type: "agentMessage",
      id: "message-1",
      text: "a",
      phase: "commentary",
    };

    expect(timelineItemRenderIdentity({ ...message, text: "ab" })).toBe(
      timelineItemRenderIdentity(message),
    );
    expect(timelineItemRenderIdentity({ ...message, phase: "finalAnswer" })).not.toBe(
      timelineItemRenderIdentity(message),
    );
    expect(timelineItemRenderIdentity({ ...message, phase: null })).toBe(
      timelineItemRenderIdentity({ ...message, phase: "finalAnswer" }),
    );
  });

  it("keeps a file expansion attached to its path across diff updates", () => {
    const change = {
      path: "src/App.tsx",
      kind: { type: "update" as const, movePath: null },
      diff: "-old\n+new",
      lineStats: null,
    };

    expect(timelineFileChangeIdentity({ ...change, diff: `${change.diff}\n+next` }, 0)).toBe(
      timelineFileChangeIdentity(change, 0),
    );
    expect(timelineFileChangeIdentity(change, 1)).not.toBe(timelineFileChangeIdentity(change, 0));
  });

  it("derives structural prefixes without scanning unrelated disclosure keys", () => {
    const thread = encodeTimelineIdentitySegment("thread");
    const group = `${thread}${encodeTimelineIdentitySegment("group")}`;
    const item = `${group}${encodeTimelineIdentitySegment("item")}`;

    expect(timelineIdentityPrefixes(item)).toEqual([thread, group, item]);
    expect(() => timelineIdentityPrefixes("4:bad|")).toThrow("incomplete segment");
  });
});
