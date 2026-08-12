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

describe("seleção de inteligência do Chat", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it("deriva o padrão do catálogo consumidor sem persistir override", () => {
    const options = [
      option("instant", "Instantâneo"),
      option("thinking", "Pensamento", { isDefault: true, thinkingEffort: "standard" }),
    ];

    expect(loadChatIntelligenceSelection()).toBeNull();
    expect(resolveChatIntelligence(options, null)).toMatchObject({
      option: { id: "thinking", thinkingEffort: "standard" },
    });
    expect(localStorage.length).toBe(0);
  });

  it("persiste somente a opção explícita e permite voltar ao padrão", () => {
    const selection = { version: 2, optionId: "gpt-5.6-pro#pro#max" } as const;

    saveChatIntelligenceSelection(selection);
    expect(loadChatIntelligenceSelection()).toEqual(selection);

    clearChatIntelligenceSelection();
    expect(loadChatIntelligenceSelection()).toBeNull();
  });

  it("representa Pro como preset oficial com modelo e thinking_effort próprios", () => {
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

  it("ignora uma opção removida do catálogo atual", () => {
    const current = option("current", "Atual", { isDefault: true });

    expect(
      resolveChatIntelligence([current], {
        version: 2,
        optionId: "removed",
      }),
    ).toMatchObject({ option: { id: "current" } });
  });

  it("descarta qualquer preferência incompatível sem manter contrato legado", () => {
    localStorage.setItem(
      "chatgpt-last-selected-model-v1",
      JSON.stringify({
        version: 1,
        obsoleteOption: "pro",
      }),
    );

    expect(loadChatIntelligenceSelection()).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});
