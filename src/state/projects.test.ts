import { beforeEach, describe, expect, it } from "vitest";

import { PROFILE_STORAGE_KEYS } from "./profileStorage";
import { addProject, loadProjects, saveProjects } from "./projects";

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

describe("project storage", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
  });

  it("preserves a Windows drive root", () => {
    const projects = addProject([], "C:\\");

    expect(projects).toEqual([{ name: "C:", path: "C:\\" }]);
  });

  it("normalizes separators without accepting drive-relative paths", () => {
    expect(addProject([], "D:/code/project/")[0]?.path).toBe("D:\\code\\project");
    expect(() => addProject([], "D:project")).toThrow("absoluto");
  });

  it("preserves project order when selecting an existing project", () => {
    const projects = [
      { name: "first", path: "D:\\code\\first" },
      { name: "second", path: "D:\\code\\second" },
    ] as const;

    expect(addProject(projects, "D:/code/second/")).toBe(projects);
  });

  it("round-trips only the closed versioned schema", () => {
    const projects = addProject([], "D:\\code\\project");
    saveProjects(projects);

    expect(loadProjects()).toEqual(projects);
  });

  it("preserves project icon colors from local storage", () => {
    localStorage.setItem(
      PROFILE_STORAGE_KEYS.projects,
      JSON.stringify({
        version: 1,
        projects: [
          {
            color: "#4ade80",
            icon: "folder",
            name: "project",
            path: "D:\\code\\project",
          },
        ],
      }),
    );

    expect(loadProjects()).toEqual([
      {
        color: "#4ade80",
        icon: "folder",
        name: "project",
        path: "D:\\code\\project",
      },
    ]);
  });
});
