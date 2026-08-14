import { beforeEach, describe, expect, it } from "vitest";

import {
  activeConversationMode,
  defaultProductFlowState,
  loadProductFlowState,
  rememberConversationDestination,
  saveProductFlowState,
  selectChatGptMode,
  selectProduct,
} from "./productFlow";
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

describe("product flow", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it("starts in Codex while ChatGPT defaults to Chat", () => {
    const state = loadProductFlowState();

    expect(state).toEqual(defaultProductFlowState());
    expect(activeConversationMode(state)).toBe("codex");
    expect(activeConversationMode(selectProduct(state, "chatgpt"))).toBe("chat");
  });

  it("restores an independent destination for every conversation mode", () => {
    let state = defaultProductFlowState();
    state = rememberConversationDestination(state, "codex", {
      threadId: "codex-thread",
      workspace: "D:\\repos\\codex",
    });
    state = rememberConversationDestination(selectChatGptMode(state, "work"), "work", {
      threadId: "work-thread",
      workspace: "D:\\repos\\report",
    });
    state = rememberConversationDestination(selectChatGptMode(state, "chat"), "chat", {
      threadId: "chat-thread",
      workspace: null,
    });
    saveProductFlowState(state);

    expect(loadProductFlowState()).toEqual(state);
    expect(activeConversationMode(state)).toBe("chat");
    expect(selectProduct(state, "codex").destinations.codex.threadId).toBe("codex-thread");
  });

  it("rejects malformed persisted state instead of guessing", () => {
    localStorage.setItem(
      PROFILE_STORAGE_KEYS.productFlow,
      JSON.stringify({ version: 1, product: "chatgpt", chatGptMode: "chat" }),
    );

    expect(() => loadProductFlowState()).toThrow(/campos incompatíveis/u);
  });
});
