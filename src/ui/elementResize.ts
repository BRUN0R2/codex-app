export interface ElementResizeObserverAdapter {
  readonly disconnect: () => void;
  readonly observe: (element: Element, options?: ResizeObserverOptions) => void;
  readonly unobserve: (element: Element) => void;
}

export type ElementResizeObserverFactory = (
  callback: ResizeObserverCallback,
) => ElementResizeObserverAdapter;

export type ElementResizeDeliveryScheduler = (callback: () => void) => () => void;

export function readResizeObserverBorderBoxHeight(entry: ResizeObserverEntry): number | null {
  const blockSize = entry.borderBoxSize?.[0]?.blockSize;
  return blockSize !== undefined && Number.isFinite(blockSize) && blockSize >= 0 ? blockSize : null;
}

export class ElementResizeObserverHub {
  readonly #createObserver: ElementResizeObserverFactory;
  readonly #scheduleDelivery: ElementResizeDeliveryScheduler;
  readonly #listeners = new Map<Element, Set<(entry: ResizeObserverEntry) => void>>();
  readonly #pendingEntries = new Map<Element, ResizeObserverEntry>();
  #cancelScheduledDelivery: (() => void) | undefined;
  #observer: ElementResizeObserverAdapter | undefined;

  constructor(
    createObserver: ElementResizeObserverFactory = (callback) => new ResizeObserver(callback),
    scheduleDelivery: ElementResizeDeliveryScheduler = (callback) => {
      const frame = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(frame);
    },
  ) {
    this.#createObserver = createObserver;
    this.#scheduleDelivery = scheduleDelivery;
  }

  observe(element: Element, listener: (entry: ResizeObserverEntry) => void): () => void {
    let listeners = this.#listeners.get(element);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(element, listeners);
      this.#observer ??= this.#createObserver(this.#handleResize);
      this.#observer.observe(element, { box: "border-box" });
    }
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) {
        return;
      }
      active = false;
      const current = this.#listeners.get(element);
      if (current === undefined) {
        return;
      }
      current.delete(listener);
      if (current.size > 0) {
        return;
      }
      this.#listeners.delete(element);
      this.#pendingEntries.delete(element);
      this.#observer?.unobserve(element);
      if (this.#listeners.size === 0) {
        this.#cancelScheduledDelivery?.();
        this.#cancelScheduledDelivery = undefined;
        this.#pendingEntries.clear();
        this.#observer?.disconnect();
        this.#observer = undefined;
      }
    };
  }

  readonly #handleResize: ResizeObserverCallback = (entries) => {
    for (const entry of entries) {
      if (this.#listeners.has(entry.target)) {
        this.#pendingEntries.set(entry.target, entry);
      }
    }
    if (this.#pendingEntries.size > 0) {
      this.#cancelScheduledDelivery ??= this.#scheduleDelivery(this.#flushPendingEntries);
    }
  };

  readonly #flushPendingEntries = () => {
    this.#cancelScheduledDelivery = undefined;
    const entries = [...this.#pendingEntries.values()];
    this.#pendingEntries.clear();
    for (const entry of entries) {
      const listeners = this.#listeners.get(entry.target);
      if (listeners === undefined) {
        continue;
      }
      for (const listener of [...listeners]) {
        listener(entry);
      }
    }
  };
}

let sharedElementResizeObserver: ElementResizeObserverHub | undefined;

export function observeElementResize(
  element: Element,
  listener: (entry: ResizeObserverEntry) => void,
): () => void {
  sharedElementResizeObserver ??= new ElementResizeObserverHub();
  return sharedElementResizeObserver.observe(element, listener);
}
