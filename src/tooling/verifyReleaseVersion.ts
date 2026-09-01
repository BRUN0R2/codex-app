import { appendFile, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { resolveReleaseMetadata, resolveReleaseTag } from "./releaseVersion.ts";

interface VersionSource {
  readonly file: string;
  readonly version: string;
}

interface VersionManifest {
  readonly version: unknown;
}

interface ReleaseEnvironment extends NodeJS.ProcessEnv {
  readonly GITHUB_REF_NAME?: string;
  readonly GITHUB_REF_TYPE?: string;
}

const projectRoot = new URL("../../", import.meta.url);
const packageJson = decodeVersionManifest(
  "package.json",
  JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8")) as unknown,
);
const tauriConfig = decodeVersionManifest(
  "src-tauri/tauri.conf.json",
  JSON.parse(await readFile(new URL("src-tauri/tauri.conf.json", projectRoot), "utf8")) as unknown,
);
const cargoManifest = await readFile(new URL("src-tauri/Cargo.toml", projectRoot), "utf8");
const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];
const versions: readonly VersionSource[] = [
  { file: "package.json", version: decodeVersion("package.json", packageJson.version) },
  {
    file: "src-tauri/Cargo.toml",
    version: decodeVersion("src-tauri/Cargo.toml", cargoVersion),
  },
  {
    file: "src-tauri/tauri.conf.json",
    version: decodeVersion("src-tauri/tauri.conf.json", tauriConfig.version),
  },
];
const uniqueVersions = new Set(versions.map(({ version }) => version));
if (uniqueVersions.size !== 1) {
  throw new Error(
    `Versions differ: ${versions.map(({ file, version }) => `${file}=${version}`).join(", ")}`,
  );
}

const version = versions[0]?.version;
if (version === undefined) {
  throw new Error("Project version sources are empty.");
}
const releaseEnvironment: ReleaseEnvironment = process.env;
const releaseTag = resolveReleaseTag(
  releaseEnvironment.GITHUB_REF_TYPE,
  releaseEnvironment.GITHUB_REF_NAME,
);
const metadata = resolveReleaseMetadata(version, releaseTag);
const outputPath = decodeArguments(process.argv.slice(2));
if (outputPath !== undefined) {
  await appendFile(
    outputPath,
    [
      `asset_name_pattern=${metadata.assetNamePattern}`,
      `channel=${metadata.channel}`,
      `prerelease=${metadata.prerelease}`,
      `release_body=${metadata.releaseBody}`,
      `release_name=${metadata.releaseName}`,
      `signed=${metadata.signed}`,
      `tag=${metadata.tag}`,
      `tauri_arguments=${metadata.tauriArguments}`,
      `version=${metadata.version}`,
      "",
    ].join("\n"),
    "utf8",
  );
}
process.stdout.write(
  `Version is consistent: ${metadata.version} (${metadata.channel}, ${metadata.tag})\n`,
);

function decodeVersionManifest(file: string, value: unknown): VersionManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file} must contain a JSON object.`);
  }
  return value as VersionManifest;
}

function decodeVersion(file: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Version is missing from ${file}.`);
  }
  return value;
}

function decodeArguments(arguments_: readonly string[]): string | undefined {
  if (arguments_.length === 0) {
    return undefined;
  }
  const [flag, outputPath] = arguments_;
  if (arguments_.length !== 2 || flag !== "--github-output" || outputPath === undefined) {
    throw new Error("Usage: verifyReleaseVersion.ts [--github-output ABSOLUTE_PATH]");
  }
  if (!isAbsolute(outputPath)) {
    throw new Error("GitHub output path must be absolute.");
  }
  return outputPath;
}
