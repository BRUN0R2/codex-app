import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

interface PackageManifest {
  scripts?: Record<string, string>;
}

const packageManifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;
const verifyWorkflow = readFileSync(
  new URL("../.github/workflows/verify.yml", import.meta.url),
  "utf8",
);
const visualAuditScript = readFileSync(
  new URL("../scripts/verify-visual-preview.mjs", import.meta.url),
  "utf8",
);

describe("tooling bootstrap contract", () => {
  it("prepares bundled tools before benchmarks can invoke Cargo", () => {
    const benchmarkCommand = packageManifest.scripts?.["verify:benchmarks"];

    expect(benchmarkCommand).toBeDefined();
    expect(benchmarkCommand).toMatch(/^pnpm tools:bootstrap && /);
    expect(benchmarkCommand).toContain("pnpm measure:command-stream");
    expect(benchmarkCommand).toContain("pnpm measure:background-command");
  });

  it("does not duplicate push and pull-request checks for feature branches", () => {
    expect(verifyWorkflow).toMatch(/push:\r?\n {4}branches:\r?\n {6}- main/u);
  });

  it("normalizes native and page motion for deterministic visual checks", () => {
    expect(visualAuditScript).toContain('"--enable-smooth-scrolling"');
    expect(visualAuditScript).toContain('"--force-prefers-no-reduced-motion"');
    expect(visualAuditScript).toContain(
      'features: [{ name: "prefers-reduced-motion", value: "no-preference" }]',
    );
  });

  it("lets Chromium own its ephemeral DevTools port without hiding early exits", () => {
    expect(packageManifest.scripts?.["verify:visual"]).toContain(
      "node --experimental-strip-types scripts/verify-visual-preview.mjs",
    );
    expect(visualAuditScript).toContain('"--remote-debugging-port=0"');
    expect(visualAuditScript).toContain("waitForDevToolsEndpoint");
    expect(visualAuditScript).not.toContain("reservePort");
    expect(visualAuditScript).not.toContain("allowExited");
  });
});
