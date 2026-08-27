import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  scripts?: Record<string, string>;
}

const packageManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

describe("tooling bootstrap contract", () => {
  it("prepares bundled tools before benchmarks can invoke Cargo", () => {
    const benchmarkCommand = packageManifest.scripts?.["verify:benchmarks"];

    expect(benchmarkCommand).toBeDefined();
    expect(benchmarkCommand).toMatch(/^pnpm tools:bootstrap && /);
    expect(benchmarkCommand).toContain("pnpm measure:command-stream");
    expect(benchmarkCommand).toContain("pnpm measure:background-command");
  });
});
