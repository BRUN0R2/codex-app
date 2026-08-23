import { describe, expect, it } from "vitest";

import { TimelineThreadSessionStore } from "./timelineSession";
import { VariableSizeVirtualizer } from "./variableSizeVirtualizer";

describe("timeline thread sessions", () => {
  it("restores measured heights and the viewport when returning to a conversation", () => {
    const sessions = new TimelineThreadSessionStore(() => new VariableSizeVirtualizer(100), 4);
    const firstTurns = turns("one", "two");
    const first = sessions.activate("thread-a", firstTurns).session;
    first.virtualizer.measure("thread-a\u0000one", 240);
    sessions.save("thread-a", {
      anchor: {
        anchor: { key: "thread-a\u0000one", offsetWithinItem: 135 },
        viewportOffset: 0,
      },
      followingLatest: false,
      scrollTop: 135,
    });

    sessions.activate("thread-b", turns("one"));
    const restored = sessions.activate("thread-a", firstTurns).session;

    expect(restored.followingLatest).toBe(false);
    expect(restored.scrollTop).toBe(135);
    expect(restored.anchor).toEqual({
      anchor: { key: "thread-a\u0000one", offsetWithinItem: 135 },
      viewportOffset: 0,
    });
    expect(restored.virtualizer).toBe(first.virtualizer);
    expect(restored.virtualizer.totalSize()).toBe(340);
  });

  it("evicts only inactive metadata when the bounded cache reaches capacity", () => {
    const sessions = new TimelineThreadSessionStore(() => new VariableSizeVirtualizer(100), 2);
    const first = sessions.activate("thread-a", turns("one")).session;
    first.virtualizer.measure("thread-a\u0000one", 240);
    sessions.activate("thread-b", turns("one"));
    sessions.activate("thread-c", turns("one"));

    const recreated = sessions.activate("thread-a", turns("one")).session;

    expect(recreated.followingLatest).toBe(true);
    expect(recreated.scrollTop).toBe(0);
    expect(recreated.virtualizer).not.toBe(first.virtualizer);
    expect(recreated.virtualizer.totalSize()).toBe(100);
  });

  it("derives virtual keys only when the immutable turn source changes", () => {
    const sessions = new TimelineThreadSessionStore(() => new VariableSizeVirtualizer(100), 2);
    const source = turns("one", "two");

    expect(sessions.activate("thread-a", source).keysChanged).toBe(true);
    expect(sessions.activate("thread-a", source).keysChanged).toBe(false);
    expect(sessions.activate("thread-a", [...source]).keysChanged).toBe(false);
    expect(sessions.activate("thread-a", turns("one", "three")).keysChanged).toBe(true);
  });

  it("invalidates width-dependent measurements when the layout signature changes", () => {
    const sessions = new TimelineThreadSessionStore(() => new VariableSizeVirtualizer(100), 2);
    const source = turns("one", "two");
    const first = sessions.activate("thread-a", source, "640:14:unified");
    first.session.virtualizer.measure("thread-a\u0000one", 240);

    const equivalent = sessions.activate("thread-a", source, "640:14:unified");
    expect(equivalent.measurementsReset).toBe(false);
    expect(equivalent.session.virtualizer.totalSize()).toBe(340);

    const resized = sessions.activate("thread-a", source, "520:14:unified");
    expect(resized.measurementsReset).toBe(true);
    expect(resized.session.virtualizer.totalSize()).toBe(200);
  });
});

function turns(...ids: readonly string[]): readonly { readonly id: string }[] {
  return ids.map((id) => ({ id }));
}
