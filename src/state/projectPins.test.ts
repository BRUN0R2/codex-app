import { beforeEach, describe, expect, it } from "vitest";

import {
  loadPinnedProjectPaths,
  partitionProjectsByPinnedPaths,
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

  it("particiona projetos fixados e comuns sem duplicar entradas", () => {
    const first = { name: "Primeiro", path: "C:\\Projetos\\Primeiro" };
    const pinned = { name: "Fixado", path: "C:\\Projetos\\Fixado" };
    const last = { name: "Último", path: "C:\\Projetos\\Ultimo" };

    expect(
      partitionProjectsByPinnedPaths(
        [first, pinned, last],
        ["c:/projetos/fixado", "C:\\Projetos\\Inexistente"],
      ),
    ).toEqual({
      pinnedProjects: [pinned],
      unpinnedProjects: [first, last],
    });
  });

  it("rejects corrupt or incompatible payloads", () => {
    localStorage.setItem("codex-desktop.profile-v2.pinned-projects", "{not json");
    expect(() => loadPinnedProjectPaths()).toThrow("invalid JSON");

    localStorage.setItem(
      "codex-desktop.profile-v2.pinned-projects",
      JSON.stringify({ version: 2, projectPaths: [] }),
    );
    expect(() => loadPinnedProjectPaths()).toThrow("unsupported");

    localStorage.setItem(
      "codex-desktop.profile-v2.pinned-projects",
      JSON.stringify({ version: 1, projectPaths: ["C:\\P"], extra: true }),
    );
    expect(() => loadPinnedProjectPaths()).toThrow("incompatible fields");
  });

  it("rejects paths duplicated after normalization", () => {
    expect(() => savePinnedProjectPaths(["C:\\Projects\\Codex", "c:/projects/codex"])).toThrow(
      "duplicated",
    );
  });

  it("rejects paths that are not absolute on Windows", () => {
    expect(() => togglePinnedProjectPath([], "projects/codex")).toThrow("absolute");
  });
});
