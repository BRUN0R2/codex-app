import { beforeEach, describe, expect, it } from "vitest";

import {
  decodePersistedBrowserState,
  loadPersistedBrowserConversations,
  savePersistedBrowserConversations,
} from "./browserPersistence";
import { PROFILE_STORAGE_KEYS } from "./profileStorage";

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

const LEGACY_STORAGE_KEY = "codex-browser-tabs-v1";

const conversation = {
  conversationId: "thread-1",
  activeBrowserTabId: "tab-1",
  tabs: [
    { browserTabId: "tab-1", url: "https://example.com" },
    { browserTabId: "tab-2", url: "about:blank" },
  ],
};

describe("browser persistence", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it("decodes a closed versioned tab topology", () => {
    const state = { version: 1, conversations: [conversation] };

    expect(decodePersistedBrowserState(state)).toEqual(state);
  });

  it("bounds tabs per conversation without treating persisted tasks as live WebViews", () => {
    const conversations = Array.from({ length: 17 }, (_, index) => ({
      conversationId: `thread-${index}`,
      activeBrowserTabId: `tab-${index}`,
      tabs: [{ browserTabId: `tab-${index}`, url: "about:blank" }],
    }));

    expect(decodePersistedBrowserState({ version: 1, conversations }).conversations).toHaveLength(
      17,
    );
    expect(() =>
      decodePersistedBrowserState({
        version: 1,
        conversations: [
          {
            conversationId: "thread-overflow",
            activeBrowserTabId: "overflow-tab-0",
            tabs: Array.from({ length: 17 }, (_, index) => ({
              browserTabId: `overflow-tab-${index}`,
              url: "about:blank",
            })),
          },
        ],
      }),
    ).toThrow("per-conversation");
  });

  it("rejects privileged URLs, duplicate ids, and unknown fields", () => {
    expect(() =>
      decodePersistedBrowserState({
        version: 1,
        conversations: [
          { ...conversation, tabs: [{ browserTabId: "tab-1", url: "file:///C:/secret.txt" }] },
        ],
      }),
    ).toThrow("not allowed");
    expect(() =>
      decodePersistedBrowserState({
        version: 1,
        conversations: [
          {
            ...conversation,
            tabs: [
              { browserTabId: "tab-1", url: "about:blank" },
              { browserTabId: "tab-1", url: "about:blank" },
            ],
          },
        ],
      }),
    ).toThrow("globally unique");
    expect(() =>
      decodePersistedBrowserState({ version: 1, conversations: [], future: true }),
    ).toThrow("unexpected fields");
  });

  it("persists through the documented profile key without leaving the legacy key", () => {
    savePersistedBrowserConversations([conversation]);

    const loaded = loadPersistedBrowserConversations();

    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(PROFILE_STORAGE_KEYS.browserTabs)).toContain("thread-1");
    expect(loaded).toEqual({ conversations: [conversation], error: null });
  });

  it("migrates the legacy key into the documented profile key in one shot", () => {
    localStorage.setItem(
      LEGACY_STORAGE_KEY,
      JSON.stringify({ version: 1, conversations: [conversation] }),
    );

    const loaded = loadPersistedBrowserConversations();

    expect(loaded).toEqual({ conversations: [conversation], error: null });
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEYS.browserTabs) ?? "")).toEqual({
      version: 1,
      conversations: [conversation],
    });
  });

  it("surfaces a corrupt legacy key without writing migrated state", () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, "{");

    const loaded = loadPersistedBrowserConversations();

    expect(loaded.conversations).toEqual([]);
    expect(loaded.error).toBeInstanceOf(Error);
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(PROFILE_STORAGE_KEYS.browserTabs)).toBeNull();
  });
});
