import { describe, expect, it } from "vitest";

import type { CodexThread, ProjectRecord } from "../contracts/types";
import { threadsWithoutConfiguredProject } from "./sidebarThreads";

describe("sidebar thread projection", () => {
  it("reserves recents for tasks without a configured project", () => {
    const projects = [
      { name: "one", path: "D:\\code\\one" },
      { name: "two", path: "D:\\code\\two" },
    ] as const satisfies readonly ProjectRecord[];
    const threads = [
      threadFixture("project-one", "d:/code/one/"),
      threadFixture("project-two", "D:\\code\\two"),
      threadFixture("recent", "D:\\scratch"),
    ];

    expect(threadsWithoutConfiguredProject(threads, projects).map((thread) => thread.id)).toEqual([
      "recent",
    ]);
  });

  it("returns every task when there are no configured projects", () => {
    const threads = [threadFixture("one", "D:\\code\\one"), threadFixture("two", "D:\\two")];

    expect(threadsWithoutConfiguredProject(threads, [])).toBe(threads);
  });

  it("keeps a projectless task in recents independently of its execution directory", () => {
    const projects = [{ name: "one", path: "D:\\code\\one" }] as const;
    const thread = threadFixture("standalone", null, "D:\\code\\one");

    expect(threadsWithoutConfiguredProject([thread], projects)).toEqual([thread]);
  });
});

function threadFixture(
  id: string,
  projectPath: string | null,
  cwd = projectPath ?? "D:\\local",
): CodexThread {
  return {
    id,
    preview: id,
    name: null,
    cwd,
    projectPath,
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "idle" },
    turns: [],
  };
}
