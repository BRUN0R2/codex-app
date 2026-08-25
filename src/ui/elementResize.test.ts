import { describe, expect, it } from "vitest";

import {
  type ElementResizeObserverAdapter,
  ElementResizeObserverHub,
  readResizeObserverBorderBoxHeight,
} from "./elementResize";

describe("shared element resize observer", () => {
  it("reads the delivered border-box height without another layout measurement", () => {
    expect(
      readResizeObserverBorderBoxHeight({
        borderBoxSize: [{ blockSize: 247.5, inlineSize: 800 }],
      } as unknown as ResizeObserverEntry),
    ).toBe(247.5);
    expect(
      readResizeObserverBorderBoxHeight({ borderBoxSize: [] } as unknown as ResizeObserverEntry),
    ).toBeNull();
  });

  it("shares one native observation and releases it after the final listener", () => {
    let observer: FakeResizeObserver | undefined;
    const scheduler = new FakeResizeScheduler();
    const hub = new ElementResizeObserverHub((callback) => {
      observer = new FakeResizeObserver(callback);
      return observer;
    }, scheduler.schedule);
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
    expect(observer?.observedBox).toBe("border-box");
    observer?.emit(element);
    expect({ firstCalls, secondCalls }).toEqual({ firstCalls: 0, secondCalls: 0 });
    scheduler.flush();
    expect({ firstCalls, secondCalls }).toEqual({ firstCalls: 1, secondCalls: 1 });

    releaseFirst();
    expect(observer?.unobserveCalls).toBe(0);
    observer?.emit(element);
    scheduler.flush();
    expect({ firstCalls, secondCalls }).toEqual({ firstCalls: 1, secondCalls: 2 });

    releaseSecond();
    expect(observer?.unobserveCalls).toBe(1);
    expect(observer?.disconnectCalls).toBe(1);
  });

  it("coalesces repeated native entries into one frame delivery", () => {
    let observer: FakeResizeObserver | undefined;
    const scheduler = new FakeResizeScheduler();
    const hub = new ElementResizeObserverHub((callback) => {
      observer = new FakeResizeObserver(callback);
      return observer;
    }, scheduler.schedule);
    const element = {} as Element;
    let calls = 0;
    hub.observe(element, () => {
      calls += 1;
    });

    observer?.emit(element);
    observer?.emit(element);
    observer?.emit(element);
    expect(scheduler.pending).toBe(1);
    scheduler.flush();

    expect(calls).toBe(1);
  });
});

class FakeResizeScheduler {
  #callbacks: Array<() => void> = [];

  get pending(): number {
    return this.#callbacks.length;
  }

  readonly schedule = (callback: () => void): (() => void) => {
    this.#callbacks.push(callback);
    return () => {
      this.#callbacks = this.#callbacks.filter((entry) => entry !== callback);
    };
  };

  flush(): void {
    const callbacks = this.#callbacks;
    this.#callbacks = [];
    for (const callback of callbacks) {
      callback();
    }
  }
}

class FakeResizeObserver implements ElementResizeObserverAdapter {
  disconnectCalls = 0;
  observeCalls = 0;
  observedBox: ResizeObserverBoxOptions | undefined;
  unobserveCalls = 0;
  readonly #callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
  }

  observe(_element: Element, options?: ResizeObserverOptions): void {
    this.observeCalls += 1;
    this.observedBox = options?.box;
  }

  unobserve(): void {
    this.unobserveCalls += 1;
  }

  emit(element: Element): void {
    this.#callback([{ target: element } as ResizeObserverEntry], this as ResizeObserver);
  }
}
