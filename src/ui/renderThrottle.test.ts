import { describe, expect, it } from "vitest";

import {
  createLatestValueThrottle,
  markdownStreamRenderInterval,
  type RenderThrottleScheduler,
} from "./renderThrottle";

class ManualScheduler implements RenderThrottleScheduler {
  private callbacks = new Map<number, { readonly at: number; readonly callback: () => void }>();
  private currentTime = 0;
  private sequence = 0;

  readonly cancel = (handle: number): void => {
    this.callbacks.delete(handle);
  };

  readonly now = (): number => this.currentTime;

  readonly schedule = (callback: () => void, delayMs: number): number => {
    this.sequence += 1;
    this.callbacks.set(this.sequence, { at: this.currentTime + delayMs, callback });
    return this.sequence;
  };

  advance(milliseconds: number): void {
    this.currentTime += milliseconds;
    const due = [...this.callbacks.entries()]
      .filter(([, entry]) => entry.at <= this.currentTime)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [handle, entry] of due) {
      this.callbacks.delete(handle);
      entry.callback();
    }
  }
}

describe("latest value render throttle", () => {
  it("emits the first value immediately and only the latest pending value", () => {
    const scheduler = new ManualScheduler();
    const values: string[] = [];
    const throttle = createLatestValueThrottle({
      emit: (value: string) => values.push(value),
      scheduler,
    });

    throttle.push("A", 50);
    throttle.push("AB", 50);
    throttle.push("ABC", 50);
    scheduler.advance(49);
    expect(values).toEqual(["A"]);
    scheduler.advance(1);
    expect(values).toEqual(["A", "ABC"]);
  });

  it("flushes terminal content immediately and cancels stale schedules", () => {
    const scheduler = new ManualScheduler();
    const values: string[] = [];
    const throttle = createLatestValueThrottle({
      emit: (value: string) => values.push(value),
      scheduler,
    });

    throttle.push("partial", 100);
    throttle.push("pending", 100);
    throttle.push("final", 100, true);
    scheduler.advance(100);

    expect(values).toEqual(["partial", "final"]);
  });

  it("adapts the render interval to accumulated Markdown size", () => {
    expect(markdownStreamRenderInterval(1_000)).toBe(16);
    expect(markdownStreamRenderInterval(10_000)).toBe(33);
    expect(markdownStreamRenderInterval(40_000)).toBe(66);
    expect(markdownStreamRenderInterval(200_000)).toBe(125);
  });
});
