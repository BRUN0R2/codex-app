import { describe, expect, it } from "vitest";

import type { FileChange, ThreadOutput } from "../contracts/types";
import { ActivityContentProjectionCache } from "./activityContentProjectionCache";

describe("ActivityContentProjectionCache", () => {
  it("reuses immutable diff and source projections by their contract identity", () => {
    const cache = new ActivityContentProjectionCache({ maximumEntries: 2, maximumWeight: 20_000 });
    const change = fileChange("src/main.ts", "+const ready = true;");
    const output = threadOutput("source-1", "1: const ready = true;");

    expect(cache.diffDocument(change)).toBe(cache.diffDocument(change));
    expect(cache.sourceProjection(output, output.preview, "src/main.ts")).toBe(
      cache.sourceProjection(output, output.preview, "src/main.ts"),
    );
  });

  it("reprojects a paginated source when its text changes", () => {
    const cache = new ActivityContentProjectionCache({ maximumEntries: 2, maximumWeight: 20_000 });
    const output = threadOutput("source-1", "1: const ready = true;");
    const initial = cache.sourceProjection(output, output.preview, "src/main.ts");
    const complete = cache.sourceProjection(
      output,
      `${output.preview}\n2: export { ready };`,
      "src/main.ts",
    );

    expect(initial?.lines).toHaveLength(1);
    expect(complete?.lines).toHaveLength(2);
    expect(complete).not.toBe(initial);
  });
});

function fileChange(path: string, diff: string): FileChange {
  return {
    path,
    diff,
    kind: { type: "update", movePath: null },
    lineStats: { additions: 1, deletions: 0 },
  };
}

function threadOutput(id: string, preview: string): ThreadOutput {
  return {
    id,
    byteLength: new TextEncoder().encode(preview).length,
    nextCursor: null,
    preview,
  };
}
