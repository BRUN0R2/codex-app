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
const documentShell = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const defaultCatalog = JSON.parse(
  readFileSync(new URL("./i18n/locales/en.json", import.meta.url), "utf8"),
) as { locale?: unknown };
const typeConfiguration = readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8");
const formatterConfiguration = readFileSync(new URL("../biome.json", import.meta.url), "utf8");

describe("tooling bootstrap contract", () => {
  it("prepares bundled tools before benchmarks can invoke Cargo", () => {
    const benchmarkCommand = packageManifest.scripts?.["verify:benchmarks"];
    const frontendCommand = packageManifest.scripts?.["verify:frontend"];
    const verifyCommand = packageManifest.scripts?.["verify"];

    expect(benchmarkCommand).toBeDefined();
    expect(benchmarkCommand).toMatch(/^pnpm tools:bootstrap && /);
    expect(benchmarkCommand).toContain("pnpm measure:command-stream");
    expect(benchmarkCommand).toContain("pnpm measure:background-command");
    expect(frontendCommand).toContain("pnpm verify:visual");
    expect(frontendCommand).not.toContain("verify:benchmarks");
    expect(frontendCommand).not.toContain("native:cargo");
    expect(verifyCommand).toBe(
      "pnpm verify:frontend && pnpm verify:native && pnpm verify:benchmarks",
    );
  });

  it("pins hashed sandboxed V8 prebuilts instead of compiling V8 from source", () => {
    const v8Manifest = JSON.parse(
      readFileSync(new URL("../scripts/v8-manifest.json", import.meta.url), "utf8"),
    ) as {
      schemaVersion?: unknown;
      version?: unknown;
      releaseBaseUrl?: unknown;
      targets?: Record<string, { archiveAssetName?: unknown; archiveSha256?: unknown }>;
    };
    const cargoConfig = readFileSync(new URL("../.cargo/config.toml", import.meta.url), "utf8");

    expect(v8Manifest.schemaVersion).toBe(1);
    expect(v8Manifest.version).toBe("152.2.0");
    expect(String(v8Manifest.releaseBaseUrl ?? "")).toContain("rusty-v8-v152.2.0");
    expect(v8Manifest.targets?.["x86_64-pc-windows-msvc"]?.archiveAssetName).toContain(
      "ptrcomp_sandbox",
    );
    expect(String(v8Manifest.targets?.["x86_64-pc-windows-msvc"]?.archiveSha256 ?? "")).toMatch(
      /^[0-9a-f]{64}$/u,
    );
    expect(projectToolsScript).toContain("v8-manifest.json");
    expect(projectToolsScript).toContain(".tools\\v8\\current");
    expect(cargoConfig).toContain("RUSTY_V8_ARCHIVE");
    expect(cargoConfig).not.toContain("V8_FROM_SOURCE");
    const nativeBuildScript = readFileSync(
      new URL("../scripts/native-build.ps1", import.meta.url),
      "utf8",
    );
    expect(nativeBuildScript).toContain("CODEX_NATIVE_BUILD_JOBS");
    expect(nativeBuildScript).toContain("CARGO_BUILD_JOBS");
    expect(nativeBuildScript).toContain("Math]::Min(8");
  });

  it("does not duplicate push and pull-request checks for feature branches", () => {
    expect(verifyWorkflow).toMatch(/push:\r?\n {4}branches:\r?\n {6}- main/u);
  });

  it("keeps the frontend verify job free of the sandboxed V8 compile", () => {
    const frontendJob = verifyWorkflow.split("name: Native Windows")[0] ?? "";
    const nativeJob = verifyWorkflow.split("name: Native Windows")[1] ?? "";

    expect(frontendJob).toContain("timeout-minutes: 20");
    expect(frontendJob).toContain("pnpm verify:frontend");
    expect(frontendJob).not.toContain("Install Rust toolchain");
    expect(frontendJob).not.toContain("verify:benchmarks");
    expect(frontendJob).not.toContain("native:cargo");
    expect(nativeJob).toContain("timeout-minutes: 60");
    expect(nativeJob).toContain("Install Rust toolchain");
    expect(nativeJob).toContain("pnpm verify:benchmarks");
    expect(nativeJob).toContain("pnpm native:cargo check");
    expect(nativeJob).toContain("~/.cargo/target/codex-desktop-next");
  });

  it("normalizes native and page motion for deterministic visual checks", () => {
    expect(visualAuditRuntime).toContain('"--enable-smooth-scrolling"');
    expect(visualAuditRuntime).toContain('"--force-prefers-no-reduced-motion"');
    expect(visualAuditScript).toContain(
      'features: [{ name: "prefers-reduced-motion", value: scenario.reducedMotion === true ? "reduce" : "no-preference" }]',
    );
  });

  it("scopes a background Chromium target to each visual scenario and viewport", () => {
    expect(packageManifest.scripts?.["verify:visual"]).toContain(
      "node --experimental-strip-types scripts/verify-visual-preview.mjs",
    );
    expect(visualAuditRuntime).toContain('"--remote-debugging-port=0"');
    expect(visualAuditRuntime).toContain('"--edge-skip-compat-layer-relaunch"');
    expect(visualAuditRuntime).toContain('"--no-startup-window"');
    expect(visualAuditScript).toContain("chromiumAuditArguments(browserProfile)");
    expect(visualAuditScript).toMatch(
      /for \(const viewport of \(scenario\.viewports \?\? VIEWPORTS\)\.filter\([\s\S]*?\)\) \{\s*reports\.push\(\s*await withAuditTarget\(browserController,/u,
    );
    expect(visualAuditScript).not.toContain("/json/new");
    expect(visualAuditScript).not.toContain("/json/close");
    expect(visualAuditScript).toContain("waitForDevToolsEndpoint");
    expect(visualAuditScript).not.toContain("/json/version");
    expect(visualAuditScript).not.toContain("reservePort");
    expect(visualAuditScript).not.toContain("allowExited");
  });

  it("does not fail 100,000-file scrolling on CI paint-work noise", () => {
    const extremeValidator = visualAuditScript.slice(
      visualAuditScript.indexOf("function validateTimelineExtremeFilesMetrics"),
    );
    expect(extremeValidator).toContain("rapidP99ApplicationWorkMs <= 8");
    expect(extremeValidator).toContain("rapidP99FrameWorkMs <= 20");
    expect(extremeValidator).not.toContain("rapidP99FrameWorkMs <= 12");
  });

  it("audits usage settings against the preview plan price formatter", () => {
    expect(visualAuditScript).toContain("formatPlanPriceAmount");
    expect(visualAuditScript).toContain("previewCurrentPlanPrice");
    expect(visualAuditScript).toContain("compactVisibleText");
    expect(visualAuditScript).not.toContain("525,00");
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

  it("fails native entrypoints when the bundled search tool is unavailable", () => {
    expect(projectToolsScript).toContain(
      "throw \"Local ripgrep is missing or invalid. Run 'pnpm tools:bootstrap'.\"",
    );
    expect(projectToolsScript).not.toContain("[switch]$Required");
  });

  it("matches the static document language to the canonical translation catalog", () => {
    expect(defaultCatalog.locale).toBe("en");
    expect(documentShell).toContain('<html lang="en">');
  });

  it("keeps lint and typing gates covering benchmark scripts", () => {
    const lintKey = "lint";
    expect(packageManifest.scripts?.[lintKey]).toContain("scripts");
    expect(typeConfiguration).toContain('"scripts"');
    expect(formatterConfiguration).toContain("scripts/**/*.ts");
  });
});
