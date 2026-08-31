import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("translation message runtime", () => {
  it("keeps presentation modules importable by native Node benchmarks", () => {
    const moduleUrl = new URL("../ui/agentActivityPresentation.ts", import.meta.url).href;
    const importHook = new URL("../../scripts/register-typescript-imports.mjs", import.meta.url)
      .href;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        importHook,
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(moduleUrl)});`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
});
