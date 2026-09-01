export type ReleaseChannel = "alpha" | "stable";

export interface ReleaseMetadata {
  readonly assetNamePattern: string;
  readonly channel: ReleaseChannel;
  readonly prerelease: boolean;
  readonly releaseBody: string;
  readonly releaseName: string;
  readonly signed: boolean;
  readonly tag: string;
  readonly tauriArguments: string;
  readonly version: string;
}

const STABLE_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const ALPHA_VERSION_PATTERN =
  /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-alpha\.([1-9]\d*)$/u;

export function resolveReleaseTag(
  referenceType: string | undefined,
  referenceName: string | undefined,
): string | undefined {
  if (referenceType !== "tag") {
    return undefined;
  }
  if (referenceName === undefined || referenceName.length === 0) {
    throw new Error("GitHub tag reference is missing its name.");
  }
  return referenceName;
}

export function resolveReleaseMetadata(version: string, releaseTag?: string): ReleaseMetadata {
  const expectedTag = `v${version}`;
  if (releaseTag !== undefined && releaseTag !== expectedTag) {
    throw new Error(`Tag ${releaseTag} does not match version ${expectedTag}.`);
  }

  const alphaMatch = ALPHA_VERSION_PATTERN.exec(version);
  if (alphaMatch !== null) {
    const baseVersion = alphaMatch[1];
    const sequence = alphaMatch[2];
    if (baseVersion === undefined || sequence === undefined) {
      throw new Error(`Alpha version ${version} could not be decoded.`);
    }
    return {
      assetNamePattern: "Alpha-Codex-App_[version]_[arch][setup][ext]",
      channel: "alpha",
      prerelease: true,
      releaseBody: `Codex App ${baseVersion} alpha ${sequence} for Windows. This installer is intentionally unsigned until Authenticode provisioning is complete; Windows may display a SmartScreen warning.`,
      releaseName: `Alpha Codex App ${baseVersion}`,
      signed: false,
      tag: expectedTag,
      tauriArguments: "",
      version,
    };
  }

  if (STABLE_VERSION_PATTERN.test(version)) {
    return {
      assetNamePattern: "Codex-App_[version]_[arch][setup][ext]",
      channel: "stable",
      prerelease: false,
      releaseBody: "Official signed Codex App installer for Windows.",
      releaseName: `Codex App v${version}`,
      signed: true,
      tag: expectedTag,
      tauriArguments: "--config src-tauri/tauri.release.generated.json",
      version,
    };
  }

  throw new Error(
    `Version ${version} is unsupported; expected MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-alpha.NUMBER.`,
  );
}
