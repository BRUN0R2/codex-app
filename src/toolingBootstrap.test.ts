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
const visualAuditRuntime = readFileSync(
  new URL("./tooling/visualAuditRuntime.ts", import.meta.url),
  "utf8",
);
const projectToolsScript = readFileSync(
  new URL("../scripts/project-tools.ps1", import.meta.url),
  "utf8",
);
const v8Manifest = readFileSync(new URL("../scripts/v8-manifest.json", import.meta.url), "utf8");

describe("tooling bootstrap contract", () => {
  it("prepares bundled tools before benchmarks can invoke Cargo", () => {
    const benchmarkCommand = packageManifest.scripts?.["verify:benchmarks"];

    expect(benchmarkCommand).toBeDefined();
    expect(benchmarkCommand).toMatch(/^pnpm tools:bootstrap && /);
    expect(benchmarkCommand).toContain("pnpm measure:command-stream");
    expect(benchmarkCommand).toContain("pnpm measure:background-command");
  });

  it("selects matching V8 archives and bindings for native or cross targets", () => {
    expect(projectToolsScript).toContain('GetEnvironmentVariable("CARGO_BUILD_TARGET")');
    expect(projectToolsScript).toContain("$targetDefinition.bindingAssetName");
    expect(v8Manifest).toContain(
      '"bindingAssetName": "src_binding_ptrcomp_sandbox_release_x86_64-pc-windows-msvc.rs"',
    );
    expect(v8Manifest).toContain(
      '"bindingAssetName": "src_binding_ptrcomp_sandbox_release_aarch64-pc-windows-msvc.rs"',
    );
  });

  it("does not duplicate push and pull-request checks for feature branches", () => {
    expect(verifyWorkflow).toMatch(/push:\r?\n {4}branches:\r?\n {6}- main/u);
  });

  it("normalizes native and page motion for deterministic visual checks", () => {
    expect(visualAuditRuntime).toContain('"--enable-smooth-scrolling"');
    expect(visualAuditRuntime).toContain('"--force-prefers-no-reduced-motion"');
    expect(visualAuditScript).toContain(
      'features: [{ name: "prefers-reduced-motion", value: "no-preference" }]',
    );
  });

  it("lets Chromium own its ephemeral DevTools port without hiding early exits", () => {
    expect(packageManifest.scripts?.["verify:visual"]).toContain(
      "node --experimental-strip-types scripts/verify-visual-preview.mjs",
    );
    expect(visualAuditRuntime).toContain('"--remote-debugging-port=0"');
    expect(visualAuditRuntime).toContain('"--edge-skip-compat-layer-relaunch"');
    expect(visualAuditScript).toContain("chromiumAuditArguments(browserProfile)");
    expect(visualAuditScript).toContain("waitForDevToolsEndpoint");
    expect(visualAuditScript).not.toContain("/json/version");
    expect(visualAuditScript).not.toContain("reservePort");
    expect(visualAuditScript).not.toContain("allowExited");
  });

  it("lets the in-process visual preview server own an ephemeral port", () => {
    expect(visualAuditScript).toContain('import { createServer } from "vite"');
    expect(visualAuditScript).toContain("loopbackHttpOrigin");
    expect(visualAuditScript).toContain("port: 0");
    expect(visualAuditScript).not.toContain("PREVIEW_PORT");
    expect(visualAuditScript).not.toContain("VITE_ENTRY");
  });

  it("probes retained timeline identity independently from display refresh rate", () => {
    expect(visualAuditScript).toContain("summaryIdentityProbeComparisons");
    expect(visualAuditScript).toContain("rapidSummaryComparisons");
    expect(visualAuditScript).not.toContain(
      "the rapid test did not compare any summary identity between consecutive frames",
    );
  });
});
