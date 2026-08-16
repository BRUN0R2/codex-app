import { describe, expect, it } from "vitest";

import { TimelineThreadSessionStore } from "./timelineSession";
import { VariableSizeVirtualizer } from "./variableSizeVirtualizer";

describe("timeline thread sessions", () => {
  it("restores measured heights and the viewport when returning to a conversation", () => {
    const sessions = new TimelineThreadSessionStore(() => new VariableSizeVirtualizer(100), 4);
    const first = sessions.activate("thread-a", ["thread-a\u0000one", "thread-a\u0000two"]);
    first.virtualizer.measure("thread-a\u0000one", 240);
    sessions.save("thread-a", { followingLatest: false, scrollTop: 135 });

    sessions.activate("thread-b", ["thread-b\u0000one"]);
    const restored = sessions.activate("thread-a", ["thread-a\u0000one", "thread-a\u0000two"]);

    expect(restored.followingLatest).toBe(false);
    expect(restored.scrollTop).toBe(135);
    expect(restored.virtualizer).toBe(first.virtualizer);
    expect(restored.virtualizer.totalSize()).toBe(340);
  });

  it("evicts only inactive metadata when the bounded cache reaches capacity", () => {
    const sessions = new TimelineThreadSessionStore(() => new VariableSizeVirtualizer(100), 2);
    const first = sessions.activate("thread-a", ["thread-a\u0000one"]);
    first.virtualizer.measure("thread-a\u0000one", 240);
    sessions.activate("thread-b", ["thread-b\u0000one"]);
    sessions.activate("thread-c", ["thread-c\u0000one"]);

    const recreated = sessions.activate("thread-a", ["thread-a\u0000one"]);

    expect(recreated.followingLatest).toBe(true);
    expect(recreated.scrollTop).toBe(0);
    expect(recreated.virtualizer).not.toBe(first.virtualizer);
    expect(recreated.virtualizer.totalSize()).toBe(100);
  });
});
