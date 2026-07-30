import type { CodexThread } from "../../shared/codex/types";
import { pathsEqual, type ProjectRecord } from "./projectStore";

export type ThreadLibraryState = "failed" | "idle" | "loading" | "ready";

export function threadTitle(thread: CodexThread): string {
  const name = thread.name?.trim();
  if (name !== undefined && name.length > 0) {
    return name;
  }
  const preview = thread.preview.trim();
  return preview.length > 0 ? preview : "Nova tarefa";
}

export function threadsForProject(
  threads: CodexThread[],
  projectPath: string,
): CodexThread[] {
  return threads.filter((thread) => pathsEqual(thread.cwd, projectPath));
}

export function recentThreads(
  threads: CodexThread[],
  projects: ProjectRecord[],
): CodexThread[] {
  return threads.filter(
    (thread) =>
      !projects.some((project) => pathsEqual(project.path, thread.cwd)),
  );
}

export function mergeThreadPage(
  current: CodexThread[],
  page: CodexThread[],
): CodexThread[] {
  const byId = new Map(current.map((thread) => [thread.id, thread]));
  for (const thread of page) {
    byId.set(thread.id, thread);
  }
  return [...byId.values()].sort(
    (left, right) => threadRecency(right) - threadRecency(left),
  );
}

function threadRecency(thread: CodexThread): number {
  return thread.recencyAt ?? thread.updatedAt;
}
