import { describe, expect, it } from "vitest";

import { type ElementResizeObserverAdapter, ElementResizeObserverHub } from "./elementResize";

describe("shared element resize observer", () => {
  it("shares one native observation and releases it after the final listener", () => {
    let observer: FakeResizeObserver | undefined;
    const hub = new ElementResizeObserverHub((callback) => {
      observer = new FakeResizeObserver(callback);
      return observer;
    });
    const element = {} as Element;
    let firstCalls = 0;
    let secondCalls = 0;
    const releaseFirst = hub.observe(element, () => {
      firstCalls += 1;
    });
    const releaseSecond = hub.observe(element, () => {
      secondCalls += 1;
    });

    expect(observer?.observeCalls).toBe(1);
    observer?.emit(element);
    expect({ firstCalls, secondCalls }).toEqual({ firstCalls: 1, secondCalls: 1 });

    releaseFirst();
    expect(observer?.unobserveCalls).toBe(0);
    observer?.emit(element);
    expect({ firstCalls, secondCalls }).toEqual({ firstCalls: 1, secondCalls: 2 });

    releaseSecond();
    expect(observer?.unobserveCalls).toBe(1);
    expect(observer?.disconnectCalls).toBe(1);
  });
});

class FakeResizeObserver implements ElementResizeObserverAdapter {
  disconnectCalls = 0;
  observeCalls = 0;
  unobserveCalls = 0;
  readonly #callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
  }

  observe(): void {
    this.observeCalls += 1;
  }

  unobserve(): void {
    this.unobserveCalls += 1;
  }

  emit(element: Element): void {
    this.#callback([{ target: element } as ResizeObserverEntry], this as ResizeObserver);
  }
}
