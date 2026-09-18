import { beforeEach, describe, expect, it } from "vitest";

import type { ChatModelOption } from "../contracts/types";
import {
  chatOptionLabel,
  clearChatIntelligenceSelection,
  loadChatIntelligenceSelection,
  resolveChatIntelligence,
  saveChatIntelligenceSelection,
  selectionFromChatOption,
} from "./chatIntelligence";
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

function option(
  id: string,
  title: string,
  options: Partial<ChatModelOption> = {},
): ChatModelOption {
  return {
    id,
    model: id,
    title,
    description: null,
    lane: null,
    thinkingEffort: null,
    versionId: null,
    selectedLabel: null,
    isDefault: false,
    ...options,
  };
}

describe("Chat intelligence selection", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it("derives the consumer catalog default without persisting an override", () => {
    const options = [
      option("instant", "Instantâneo"),
      option("thinking", "Pensamento", { isDefault: true, thinkingEffort: "standard" }),
    ];

    expect(loadChatIntelligenceSelection()).toBeNull();
    expect(resolveChatIntelligence(options, null)).toMatchObject({
      option: { id: "thinking", thinkingEffort: "standard" },
      source: "catalogDefault",
    });
    expect(localStorage.length).toBe(0);
  });

  it("persists only the explicit option and allows returning to the default", () => {
    const selection = { version: 2, optionId: "gpt-5.6-pro#pro#max" } as const;

    saveChatIntelligenceSelection(selection);
    expect(loadChatIntelligenceSelection()).toEqual(selection);

    clearChatIntelligenceSelection();
    expect(loadChatIntelligenceSelection()).toBeNull();
  });

  it("represents Pro as an official preset with its own model and thinking effort", () => {
    const pro = option("gpt-5.6-pro#pro#max", "Pro", {
      model: "gpt-5.6-pro",
      lane: "pro",
      thinkingEffort: "max",
      selectedLabel: "GPT-5.6 Pro",
    });

    expect(selectionFromChatOption(pro)).toEqual({
      version: 2,
      optionId: "gpt-5.6-pro#pro#max",
    });
    expect(chatOptionLabel(pro)).toBe("GPT-5.6 Pro");
  });

  it("exposes a removed option from the current catalog explicitly", () => {
    const current = option("current", "Atual", { isDefault: true });

    expect(
      resolveChatIntelligence([current], {
        version: 2,
        optionId: "removed",
      }),
    ).toMatchObject({ option: { id: "current" }, source: "selectionUnavailable" });
  });

  it("distinguishes an unavailable catalog from a removed selection", () => {
    expect(
      resolveChatIntelligence([], {
        version: 2,
        optionId: "saved",
      }),
    ).toEqual({ option: undefined, source: "catalogUnavailable" });
  });

  it("rejects an incompatible preference without silent mutation", () => {
    localStorage.setItem(
      PROFILE_STORAGE_KEYS.chatIntelligence,
      JSON.stringify({
        version: 1,
        obsoleteOption: "pro",
      }),
    );

    expect(() => loadChatIntelligenceSelection()).toThrow(
      "The Chat model selection has incompatible fields.",
    );
    expect(localStorage.length).toBe(1);
  });

  it("does not read or remove the previous profile preference", () => {
    localStorage.setItem("chatgpt-last-selected-model-v1", JSON.stringify({ version: 2 }));

    expect(loadChatIntelligenceSelection()).toBeNull();
    expect(localStorage.getItem("chatgpt-last-selected-model-v1")).not.toBeNull();
  });
});
