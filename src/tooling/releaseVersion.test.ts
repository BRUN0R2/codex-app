import { describe, expect, it } from "vitest";

import { resolveReleaseMetadata, resolveReleaseTag } from "./releaseVersion";

describe("release version metadata", () => {
  it("resolves an unsigned GitHub prerelease for a canonical alpha version", () => {
    expect(resolveReleaseMetadata("0.0.1-alpha.1", "v0.0.1-alpha.1")).toEqual({
      assetNamePattern: "Alpha-Codex-App_[version]_[arch][setup][ext]",
      channel: "alpha",
      prerelease: true,
      releaseBody:
        "Codex App 0.0.1 alpha 1 for Windows. This installer is intentionally unsigned until Authenticode provisioning is complete; Windows may display a SmartScreen warning.",
      releaseName: "Alpha Codex App 0.0.1",
      signed: false,
      tag: "v0.0.1-alpha.1",
      tauriArguments: "",
      version: "0.0.1-alpha.1",
    });
  });

  it("keeps stable releases signed and outside the prerelease channel", () => {
    expect(resolveReleaseMetadata("1.2.3", "v1.2.3")).toEqual({
      assetNamePattern: "Codex-App_[version]_[arch][setup][ext]",
      channel: "stable",
      prerelease: false,
      releaseBody: "Official signed Codex App installer for Windows.",
      releaseName: "Codex App v1.2.3",
      signed: true,
      tag: "v1.2.3",
      tauriArguments: "--config src-tauri/tauri.release.generated.json",
      version: "1.2.3",
    });
  });

  it("rejects mismatched tags and ambiguous prerelease formats", () => {
    expect(() => resolveReleaseMetadata("0.0.1-alpha.1", "v0.0.1")).toThrow(
      "Tag v0.0.1 does not match version v0.0.1-alpha.1.",
    );

    for (const version of [
      "0.0.1-alpha",
      "0.0.1-alpha.0",
      "0.0.1-alpha.01",
      "0.0.1-beta.1",
      "01.0.0",
    ]) {
      expect(() => resolveReleaseMetadata(version), version).toThrow("is unsupported");
    }
  });

  it("requires a name for tag events without treating branch events as releases", () => {
    expect(resolveReleaseTag("tag", "v0.0.1-alpha.1")).toBe("v0.0.1-alpha.1");
    expect(() => resolveReleaseTag("tag", undefined)).toThrow(
      "GitHub tag reference is missing its name.",
    );
    expect(resolveReleaseTag("branch", "main")).toBeUndefined();
    expect(resolveReleaseTag(undefined, undefined)).toBeUndefined();
  });
});
