import { execFileSync } from "node:child_process";

import { verifyReleaseTagSignature } from "./releaseTagSignature.ts";
import { resolveReleaseTag } from "./releaseVersion.ts";

interface ReleaseEnvironment extends NodeJS.ProcessEnv {
  readonly GITHUB_REF_TYPE?: string;
  readonly GITHUB_REF_NAME?: string;
  readonly GITHUB_REPOSITORY?: string;
  readonly GITHUB_TOKEN?: string;
}

const environment: ReleaseEnvironment = process.env;
const tag = resolveReleaseTag(environment.GITHUB_REF_TYPE, environment.GITHUB_REF_NAME);
if (tag === undefined) {
  throw new Error("Release signature verification requires a GitHub tag event.");
}
const repository = environment.GITHUB_REPOSITORY;
const token = environment.GITHUB_TOKEN;
if (repository === undefined || token === undefined) {
  throw new Error("GITHUB_REPOSITORY and GITHUB_TOKEN are required to verify the release tag.");
}
const commitSha = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
  cwd: new URL("../../", import.meta.url),
  encoding: "utf8",
  maxBuffer: 1_024,
  timeout: 5_000,
  windowsHide: true,
}).trim();

await verifyReleaseTagSignature({ repository, tag, commitSha }, token);
process.stdout.write(`GitHub verified signed release tag ${tag} at ${commitSha}.\n`);
