import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { verifyReleaseTagSignature } from "./releaseTagSignature";

const source = {
  repository: "BRUN0R2/codex-app",
  tag: "v0.0.4-alpha.1",
  commitSha: "33d6ae78e28962f9c51ed1c814df9e573c7c657d",
};
const tagSha = "6c49636b9acfe27f1c7784946db17cf61b8db661";
const reference = {
  ref: `refs/tags/${source.tag}`,
  object: { type: "tag", sha: tagSha },
};
const annotation = {
  sha: tagSha,
  tag: source.tag,
  object: { type: "commit", sha: source.commitSha },
  verification: { verified: true, reason: "valid" },
};

function gitHubResponses(...values: readonly unknown[]) {
  const request = vi.fn<typeof fetch>();
  for (const value of values) {
    request.mockResolvedValueOnce(Response.json(value));
  }
  return request;
}

describe("release tag signature", () => {
  it.each(["v0.0.4-alpha.1", "v1.2.3"])(
    "requires GitHub verification of the annotated tag for %s",
    async (tag) => {
      const request = gitHubResponses(
        { ...reference, ref: `refs/tags/${tag}` },
        { ...annotation, tag },
      );

      await verifyReleaseTagSignature({ ...source, tag }, "test-token", request);

      expect(request.mock.calls.map(([url]) => url)).toEqual([
        `https://api.github.com/repos/${source.repository}/git/ref/tags/${tag}`,
        `https://api.github.com/repos/${source.repository}/git/tags/${tagSha}`,
      ]);
      expect(request.mock.calls[0]?.[1]).toMatchObject({
        headers: { Authorization: "Bearer test-token" },
        redirect: "error",
        signal: expect.any(AbortSignal),
      });
    },
  );

  it("rejects a lightweight tag even when its commit is verified", async () => {
    const request = gitHubResponses({
      ...reference,
      object: { type: "commit", sha: source.commitSha, verification: annotation.verification },
    });
    await expect(verifyReleaseTagSignature(source, "test-token", request)).rejects.toThrow(
      "must be an annotated, signed tag",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["unsigned", "unknown_key", "unverified_email", "invalid", "gpgverify_unavailable"])(
    "blocks publication when the tag signature is %s",
    async (reason) => {
      const request = gitHubResponses(reference, {
        ...annotation,
        verification: { verified: false, reason },
      });
      await expect(verifyReleaseTagSignature(source, "test-token", request)).rejects.toThrow(
        `is not verified by GitHub (${reason})`,
      );
    },
  );

  it.each([
    { verified: "true", reason: "valid" },
    { verified: true, reason: "unsigned" },
    { verified: true },
    null,
  ])("rejects malformed or inconsistent verification metadata", async (verification) => {
    const request = gitHubResponses(reference, { ...annotation, verification });
    await expect(verifyReleaseTagSignature(source, "test-token", request)).rejects.toThrow();
  });

  it.each([
    { sha: "0".repeat(40) },
    { tag: "v0.0.1-alpha.1" },
    { object: { type: "commit", sha: "0".repeat(40) } },
    { object: { type: "tag", sha: source.commitSha } },
  ])("rejects a different tag object or checkout target", async (replacement) => {
    const request = gitHubResponses(reference, { ...annotation, ...replacement });
    await expect(verifyReleaseTagSignature(source, "test-token", request)).rejects.toThrow();
  });

  it.each([
    { ...reference, ref: "refs/tags/v0.0.1-alpha.1" },
    { ...reference, object: { type: "tag", sha: "../other" } },
    { ...reference, object: null },
    [],
  ])("rejects malformed or mismatched references before loading a tag", async (value) => {
    const request = gitHubResponses(value);
    await expect(verifyReleaseTagSignature(source, "test-token", request)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...source, repository: "https://other.example/owner/repo" },
    { ...source, tag: "v0.0.4-beta.1" },
    { ...source, tag: "v0.0.4-alpha.1/other" },
    { ...source, tag: `v${"1".repeat(100)}.0.0` },
    { ...source, commitSha: "HEAD" },
  ])("rejects invalid release inputs before contacting GitHub", async (invalidSource) => {
    const request = gitHubResponses();
    await expect(verifyReleaseTagSignature(invalidSource, "test-token", request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("requires authentication without making an anonymous retry", async () => {
    const request = gitHubResponses();
    await expect(verifyReleaseTagSignature(source, " ", request)).rejects.toThrow(
      "GITHUB_TOKEN is required",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 503])("fails closed on GitHub HTTP %s", async (status) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status }));
    await expect(verifyReleaseTagSignature(source, "test-token", request)).rejects.toThrow(
      `HTTP ${status}`,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("propagates a timed out GitHub request", async () => {
    const error = new DOMException("GitHub request timed out", "TimeoutError");
    const request = vi.fn<typeof fetch>().mockRejectedValue(error);
    await expect(verifyReleaseTagSignature(source, "test-token", request)).rejects.toBe(error);
  });

  it("cancels oversized response streams", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65 * 1_024));
      },
      cancel,
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(verifyReleaseTagSignature(source, "test-token", request)).rejects.toThrow(
      "exceeds the size limit",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([null, "not JSON", "[]"])(
    "rejects missing or malformed response bodies",
    async (body) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(verifyReleaseTagSignature(source, "test-token", request)).rejects.toThrow();
    },
  );

  it("runs the signature gate for every release before source verification and publishing", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/release.yml", import.meta.url),
      "utf8",
    );
    const gate = workflow.indexOf("      - name: Verify GitHub tag signature");
    const nextStep = workflow.indexOf("      - name:", gate + 1);
    const step = workflow.slice(gate, nextStep);

    expect(gate).toBeGreaterThan(0);
    expect(step).toMatch(/GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
    expect(step).toContain(
      "node --experimental-strip-types src/tooling/verifyReleaseTagSignature.ts",
    );
    expect(step).not.toMatch(/\b(?:if|continue-on-error):/u);
    expect(gate).toBeLessThan(workflow.indexOf("      - name: Verify source"));
    expect(gate).toBeLessThan(
      workflow.indexOf("      - name: Build and publish Windows installer"),
    );
  });
});
