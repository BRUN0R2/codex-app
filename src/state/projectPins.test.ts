import { beforeEach, describe, expect, it } from "vitest";

import {
  loadPinnedProjectPaths,
  removePinnedProjectPath,
  savePinnedProjectPaths,
  togglePinnedProjectPath,
} from "./projectPins";

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

describe("project pins", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it("carrega uma lista vazia quando não há estado salvo", () => {
    expect(loadPinnedProjectPaths()).toEqual([]);
  });

  it("alterna, persiste e recarrega caminhos normalizados", () => {
    const pinned = togglePinnedProjectPath([], "C:\\Projetos\\Codex");
    expect(pinned).toEqual(["C:\\Projetos\\Codex"]);

    savePinnedProjectPaths(pinned);
    expect(loadPinnedProjectPaths()).toEqual(["C:\\Projetos\\Codex"]);

    expect(togglePinnedProjectPath(pinned, "c:/projetos/codex")).toEqual([]);
  });

  it("remove um caminho fixado comparando de forma tolerante a maiúsculas", () => {
    expect(
      removePinnedProjectPath(["C:\\Projetos\\Codex", "C:\\Outro"], "c:/projetos/codex"),
    ).toEqual(["C:\\Outro"]);
  });

  it("rejeita payloads corrompidos ou incompatíveis", () => {
    localStorage.setItem("codex-desktop.profile-v2.pinned-projects", "{not json");
    expect(() => loadPinnedProjectPaths()).toThrow("JSON inválido");

    localStorage.setItem(
      "codex-desktop.profile-v2.pinned-projects",
      JSON.stringify({ version: 2, projectPaths: [] }),
    );
    expect(() => loadPinnedProjectPaths()).toThrow("não é suportada");

    localStorage.setItem(
      "codex-desktop.profile-v2.pinned-projects",
      JSON.stringify({ version: 1, projectPaths: ["C:\\P"], extra: true }),
    );
    expect(() => loadPinnedProjectPaths()).toThrow("campos incompatíveis");
  });

  it("rejeita caminhos duplicados após normalização", () => {
    expect(() => savePinnedProjectPaths(["C:\\Projetos\\Codex", "c:/projetos/codex"])).toThrow(
      "duplicado",
    );
  });

  it("rejeita caminhos que não são absolutos no Windows", () => {
    expect(() => togglePinnedProjectPath([], "projetos/codex")).toThrow("absoluto");
  });
});
