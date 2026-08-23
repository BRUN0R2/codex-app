import { describe, expect, it } from "vitest";

import {
  createStreamDeltaBatcher,
  type StreamDelta,
  type StreamDeltaScheduler,
} from "./streamDeltas";

class ManualScheduler implements StreamDeltaScheduler {
  private callbacks = new Map<number, () => void>();
  private sequence = 0;

  readonly cancel = (handle: number): void => {
    this.callbacks.delete(handle);
  };

  readonly schedule = (callback: () => void): number => {
    this.sequence += 1;
    this.callbacks.set(this.sequence, callback);
    return this.sequence;
  };

  flush(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) {
      callback();
    }
  }
}

describe("stream delta batcher", () => {
  it("applies the leading delta immediately and combines the rest per frame", () => {
    const scheduler = new ManualScheduler();
    const batches: (readonly StreamDelta[])[] = [];
    const batcher = createStreamDeltaBatcher({
      apply: (deltas) => batches.push(deltas),
      reportError: (reason) => {
        throw reason;
      },
      scheduler,
    });

    batcher.enqueue(agentDelta("A"));
    batcher.enqueue(agentDelta("B"));
    batcher.enqueue(agentDelta("C"));

    expect(batches).toEqual([[agentDelta("A")]]);
    scheduler.flush();
    expect(batches).toEqual([[agentDelta("A")], [agentDelta("BC")]]);
  });

  it("keeps independent item targets ordered within the same frame", () => {
    const scheduler = new ManualScheduler();
    const batches: (readonly StreamDelta[])[] = [];
    const batcher = createStreamDeltaBatcher({
      apply: (deltas) => batches.push(deltas),
      reportError: (reason) => {
        throw reason;
      },
      scheduler,
    });
    const summary = reasoningDelta("summary", 0, "S");
    const content = reasoningDelta("content", 1, "C");

    batcher.enqueue(summary);
    batcher.enqueue(content);
    batcher.enqueue({ ...summary, delta: "1" });
    batcher.enqueue({ ...content, delta: "2" });
    batcher.flush();

    expect(batches).toEqual([
      [summary],
      [content],
      [
        { ...summary, delta: "1" },
        { ...content, delta: "2" },
      ],
    ]);
  });

  it("discards pending deltas when an item completes and drops work after disposal", () => {
    const scheduler = new ManualScheduler();
    const batches: (readonly StreamDelta[])[] = [];
    const batcher = createStreamDeltaBatcher({
      apply: (deltas) => batches.push(deltas),
      reportError: (reason) => {
        throw reason;
      },
      scheduler,
    });

    batcher.enqueue(agentDelta("A"));
    batcher.enqueue(agentDelta("stale"));
    batcher.releaseItem("thread-a", "message-a");
    batcher.enqueue(agentDelta("B"));
    batcher.dispose();
    batcher.enqueue(agentDelta("C"));
    scheduler.flush();

    expect(batches).toEqual([[agentDelta("A")], [agentDelta("B")]]);
  });

  it("coalesces adjacent command appends without reordering control operations", () => {
    const scheduler = new ManualScheduler();
    const batches: (readonly StreamDelta[])[] = [];
    const batcher = createStreamDeltaBatcher({
      apply: (deltas) => batches.push(deltas),
      reportError: (reason) => {
        throw reason;
      },
      scheduler,
    });

    batcher.enqueue(commandAppend("A"));
    batcher.enqueue(commandAppend("B"));
    batcher.enqueue(commandAppend("C"));
    batcher.enqueue(commandOperation("clearCurrentLine"));
    batcher.enqueue(commandAppend("D"));
    batcher.flush();

    expect(batches).toEqual([
      [commandAppend("A")],
      [commandAppend("BC"), commandOperation("clearCurrentLine"), commandAppend("D")],
    ]);
  });
});

function agentDelta(delta: string): StreamDelta {
  return {
    kind: "agentText",
    threadId: "thread-a",
    itemId: "message-a",
    delta,
  };
}

function reasoningDelta(
  target: "content" | "summary",
  index: number,
  delta: string,
): Extract<StreamDelta, { readonly kind: "reasoningText" }> {
  return {
    kind: "reasoningText",
    threadId: "thread-a",
    itemId: "reasoning-a",
    index,
    target,
    delta,
  };
}

function commandAppend(delta: string): StreamDelta {
  return {
    kind: "commandOutput",
    threadId: "thread-a",
    turnId: "turn-a",
    itemId: "command-a",
    stream: "stdout",
    operation: { type: "append", delta },
  };
}

function commandOperation(type: "backspace" | "clearCurrentLine" | "truncated"): StreamDelta {
  return {
    kind: "commandOutput",
    threadId: "thread-a",
    turnId: "turn-a",
    itemId: "command-a",
    stream: "stdout",
    operation: { type },
  };
}
