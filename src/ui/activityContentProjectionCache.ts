import type { FileChange, ThreadOutput } from "../contracts/types";
import { createDiffDocument, type DiffDocument } from "./diffDocument";
import { projectSourceOutput, type SourceOutputProjection } from "./toolOutputProjection";
import { WeightedRecentCache } from "./weightedRecentCache";

const DEFAULT_MAXIMUM_ENTRIES = 512;
const DEFAULT_MAXIMUM_WEIGHT = 32 * 1_024 * 1_024;

interface DiffProjectionEntry {
  readonly document: DiffDocument;
}

interface SourceProjectionEntry {
  readonly path: string;
  readonly projection: SourceOutputProjection | null;
  readonly text: string;
}

export interface ActivityContentProjectionCacheLimits {
  readonly maximumEntries: number;
  readonly maximumWeight: number;
}

const DEFAULT_LIMITS: ActivityContentProjectionCacheLimits = {
  maximumEntries: DEFAULT_MAXIMUM_ENTRIES,
  maximumWeight: DEFAULT_MAXIMUM_WEIGHT,
};

export class ActivityContentProjectionCache {
  readonly #diffs: WeightedRecentCache<FileChange, DiffProjectionEntry>;
  readonly #sources: WeightedRecentCache<ThreadOutput, SourceProjectionEntry>;

  constructor(limits: ActivityContentProjectionCacheLimits = DEFAULT_LIMITS) {
    this.#diffs = new WeightedRecentCache(limits.maximumEntries, limits.maximumWeight);
    this.#sources = new WeightedRecentCache(limits.maximumEntries, limits.maximumWeight);
  }

  diffDocument(change: FileChange): DiffDocument {
    const cached = this.#diffs.read(change);
    if (cached !== null) {
      return cached.document;
    }
    const document = createDiffDocument(change.diff);
    this.#diffs.write(
      change,
      { document },
      estimateProjectionWeight(change.diff.length, document.unifiedRows.length),
    );
    return document;
  }

  sourceProjection(
    output: ThreadOutput,
    text: string,
    path: string,
  ): SourceOutputProjection | null {
    const cached = this.#sources.read(output);
    if (cached !== null && cached.text === text && cached.path === path) {
      return cached.projection;
    }
    const projection = projectSourceOutput(text, path);
    this.#sources.write(
      output,
      { path, projection, text },
      estimateProjectionWeight(text.length, projection?.lines.length ?? 0),
    );
    return projection;
  }
}

export const activityContentProjectionCache = new ActivityContentProjectionCache();

function estimateProjectionWeight(characterCount: number, rowCount: number): number {
  return Math.max(1, characterCount * 2 + rowCount * 160);
}
