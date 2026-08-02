import { beforeEach, describe, expect, it } from "vitest";

import {
  loadPinnedThreadIds,
  removePinnedThreadId,
  savePinnedThreadIds,
  togglePinnedThreadId,
} from "./pins";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

describe("pinned threads", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it("persists deterministic unique task ids", () => {
    const pinned = togglePinnedThreadId(togglePinnedThreadId([], "thread-a"), "thread-b");
    savePinnedThreadIds(pinned);

    expect(loadPinnedThreadIds()).toEqual(["thread-b", "thread-a"]);
    expect(togglePinnedThreadId(pinned, "thread-a")).toEqual(["thread-b"]);
    expect(removePinnedThreadId(pinned, "thread-b")).toEqual(["thread-a"]);
  });

  it("rejects malformed persisted state", () => {
    localStorage.setItem(
      "codex-desktop.pinned-threads.v1",
      JSON.stringify({ version: 1, threadIds: ["duplicate", "duplicate"] }),
    );
    expect(() => loadPinnedThreadIds()).toThrow(/duplicada/u);
  });
});
