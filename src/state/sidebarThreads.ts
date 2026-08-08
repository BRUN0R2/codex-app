import type { CodexThread, ProjectRecord } from "../contracts/types";
import { pathsEqual } from "./projects";

export function threadsWithoutConfiguredProject(
  threads: readonly CodexThread[],
  projects: readonly ProjectRecord[],
): readonly CodexThread[] {
  if (projects.length === 0) {
    return threads;
  }
  return threads.filter(
    (thread) => !projects.some((project) => pathsEqual(thread.projectPath, project.path)),
  );
}
