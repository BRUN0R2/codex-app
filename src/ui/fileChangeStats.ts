import type { FileChange, FileChangeLineStats } from "../contracts/types";

import { summarizeDiff } from "./diffDocument";

export function fileChangeLineStats(change: FileChange): FileChangeLineStats {
  return change.lineStats ?? summarizeDiff(change.diff);
}
