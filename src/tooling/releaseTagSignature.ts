import { resolveReleaseMetadata } from "./releaseVersion.ts";

interface ReleaseTagSource {
  readonly repository: string;
  readonly tag: string;
  readonly commitSha: string;
}

const GITHUB_API_ROOT = "https://api.github.com";
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
const MAX_GITHUB_RESPONSE_BYTES = 64 * 1_024;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;

export async function verifyReleaseTagSignature(
  source: ReleaseTagSource,
  token: string,
  request: typeof fetch = fetch,
): Promise<void> {
  const { repository, tag, commitSha } = source;
  if (repository.length > 200 || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("Release repository must be a GitHub owner/name.");
  }
  if (tag.length > 100 || !tag.startsWith("v")) {
    throw new Error("Release tag must be a canonical version prefixed with v.");
  }
  resolveReleaseMetadata(tag.slice(1), tag);
  if (!GIT_SHA_PATTERN.test(commitSha)) {
    throw new Error("Release checkout must resolve to a full commit SHA.");
  }
  if (token.trim().length === 0) {
    throw new Error("GITHUB_TOKEN is required to verify the release tag.");
  }

  const apiPath = `/repos/${repository}/git`;
  const { ref, object } = await readGitHubObject(
    `${apiPath}/ref/tags/${encodeURIComponent(tag)}`,
    token,
    request,
  );
  if (ref !== `refs/tags/${tag}`) {
    throw new Error(`GitHub returned a different reference for release tag ${tag}.`);
  }
  const { type, sha: tagSha } = decodeObject(object);
  if (type !== "tag") {
    throw new Error(
      `Release tag ${tag} must be an annotated, signed tag; a verified commit alone is insufficient.`,
    );
  }
  if (typeof tagSha !== "string" || !GIT_SHA_PATTERN.test(tagSha)) {
    throw new Error(`GitHub returned an invalid object SHA for release tag ${tag}.`);
  }

  const {
    sha,
    tag: tagName,
    object: commitObject,
    verification,
  } = await readGitHubObject(`${apiPath}/tags/${tagSha}`, token, request);
  if (sha !== tagSha || tagName !== tag) {
    throw new Error(`GitHub returned a different object for release tag ${tag}.`);
  }
  const { type: commitType, sha: targetCommitSha } = decodeObject(commitObject);
  if (commitType !== "commit" || targetCommitSha !== commitSha) {
    throw new Error(`Release tag ${tag} must point directly to checkout commit ${commitSha}.`);
  }
  const { verified, reason } = decodeObject(verification);
  if (verified !== true || reason !== "valid") {
    if (typeof reason !== "string" || !/^[a-z_]{1,64}$/u.test(reason)) {
      throw new Error(`GitHub returned an invalid signature verification result for ${tag}.`);
    }
    throw new Error(`Release tag ${tag} is not verified by GitHub (${reason}).`);
  }
}

async function readGitHubObject(
  path: string,
  token: string,
  request: typeof fetch,
): Promise<Record<string, unknown>> {
  const response = await request(`${GITHUB_API_ROOT}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
    },
    redirect: "error",
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub release tag request failed with HTTP ${response.status}.`);
  }
  if (response.body === null) {
    throw new Error("GitHub release tag response is empty.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let byteLength = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      byteLength += value.byteLength;
      if (byteLength > MAX_GITHUB_RESPONSE_BYTES) {
        throw new Error("GitHub release tag response exceeds the size limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
  return decodeObject(JSON.parse(text) as unknown);
}

function decodeObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub release tag response must contain an object.");
  }
  return value as Record<string, unknown>;
}
