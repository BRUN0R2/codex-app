export interface ElementResizeObserverAdapter {
  readonly disconnect: () => void;
  readonly observe: (element: Element) => void;
  readonly unobserve: (element: Element) => void;
}

export type ElementResizeObserverFactory = (
  callback: ResizeObserverCallback,
) => ElementResizeObserverAdapter;

export class ElementResizeObserverHub {
  readonly #createObserver: ElementResizeObserverFactory;
  readonly #listeners = new Map<Element, Set<(entry: ResizeObserverEntry) => void>>();
  #observer: ElementResizeObserverAdapter | undefined;

  constructor(
    createObserver: ElementResizeObserverFactory = (callback) => new ResizeObserver(callback),
  ) {
    this.#createObserver = createObserver;
  }

  observe(element: Element, listener: (entry: ResizeObserverEntry) => void): () => void {
    let listeners = this.#listeners.get(element);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(element, listeners);
      this.#observer ??= this.#createObserver(this.#handleResize);
      this.#observer.observe(element);
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
      this.#observer?.unobserve(element);
      if (this.#listeners.size === 0) {
        this.#observer?.disconnect();
        this.#observer = undefined;
      }
    };
  }

  readonly #handleResize: ResizeObserverCallback = (entries) => {
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
