import { beforeEach, describe, expect, it } from "vitest";

import {
  defaultProjectSidebarState,
  loadProjectSidebarState,
  projectExpanded,
  projectThreadListExpanded,
  saveProjectSidebarState,
  toggleProjectExpanded,
  toggleProjectSectionExpanded,
  toggleProjectThreadListExpanded,
} from "./projectSidebarState";

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

describe("project sidebar state", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it("keeps every project expanded by default", () => {
    const state = defaultProjectSidebarState();

    expect(state.projectsExpanded).toBe(true);
    expect(projectExpanded(state, "D:\\code\\first")).toBe(true);
    expect(projectExpanded(state, "D:\\code\\second")).toBe(true);
  });

  it("changes only the project the user explicitly toggles", () => {
    const firstProject = "D:\\code\\first";
    const secondProject = "D:\\code\\second";
    const state = toggleProjectExpanded(defaultProjectSidebarState(), firstProject);

    expect(projectExpanded(state, firstProject)).toBe(false);
    expect(projectExpanded(state, secondProject)).toBe(true);
  });

  it("round-trips project and chat-list disclosure choices", () => {
    const project = "D:\\code\\project";
    let state = defaultProjectSidebarState();
    state = toggleProjectSectionExpanded(state);
    state = toggleProjectExpanded(state, project);
    state = toggleProjectThreadListExpanded(state, project);

    saveProjectSidebarState(state);

    const restored = loadProjectSidebarState();
    expect(restored.projectsExpanded).toBe(false);
    expect(projectExpanded(restored, project)).toBe(false);
    expect(projectThreadListExpanded(restored, project)).toBe(true);
  });

  it("uses one persistent state for equivalent Windows paths", () => {
    const state = toggleProjectExpanded(defaultProjectSidebarState(), "D:/code/project/");

    expect(projectExpanded(state, "d:\\CODE\\project")).toBe(false);
  });
});
