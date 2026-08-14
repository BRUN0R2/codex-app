import type { ProjectRecord, ThreadSummary } from "../contracts/types";
import { pathsEqual } from "./projects";

export function threadsWithoutConfiguredProject(
  threads: readonly ThreadSummary[],
  projects: readonly ProjectRecord[],
): readonly ThreadSummary[] {
  if (projects.length === 0) {
    return threads;
  }
  return threads.filter(
    (thread) => !projects.some((project) => pathsEqual(thread.projectPath, project.path)),
  );
}
