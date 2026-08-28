import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compareRetainedIdentities,
  type ObservedProcess,
  observeProcess,
  parseDevToolsActivePort,
  waitForDevToolsEndpoint,
} from "./visualAuditRuntime";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("visual audit runtime", () => {
  it("compares identity only for keys retained between samples", () => {
    const retained = {};
    const replacedBefore = {};
    const replacedAfter = {};

    expect(
      compareRetainedIdentities(
        new Map([
          ["retained", retained],
          ["replaced", replacedBefore],
          ["removed", {}],
        ]),
        new Map([
          ["retained", retained],
          ["replaced", replacedAfter],
          ["added", {}],
        ]),
      ),
    ).toEqual({ replacementCount: 1, retainedCount: 2 });
  });

  it("treats disjoint samples as valid but inconclusive", () => {
    expect(compareRetainedIdentities(new Map([["before", {}]]), new Map([["after", {}]]))).toEqual({
      replacementCount: 0,
      retainedCount: 0,
    });
  });

  it("parses the ephemeral DevTools endpoint emitted by Chromium", () => {
    expect(parseDevToolsActivePort("64914\r\n/devtools/browser/session-id\r\n")).toEqual({
      browserWebSocketUrl: "ws://127.0.0.1:64914/devtools/browser/session-id",
      port: 64_914,
      versionUrl: "http://127.0.0.1:64914/json/version",
    });
  });

  it.each([
    ["missing websocket path", "64914\n"],
    ["non-numeric port", "not-a-port\n/devtools/browser/session-id\n"],
    ["out-of-range port", "65536\n/devtools/browser/session-id\n"],
    ["unexpected websocket path", "64914\n/devtools/page/session-id\n"],
  ])("rejects %s in DevToolsActivePort", (_name, content) => {
    expect(() => parseDevToolsActivePort(content)).toThrow();
  });

  it("waits for Chromium to publish DevToolsActivePort", async () => {
    const directory = await createTemporaryDirectory();
    const activePortPath = path.join(directory, "DevToolsActivePort");
    const processObservation = healthyProcessObservation();
    const pendingEndpoint = waitForDevToolsEndpoint(directory, processObservation, {
      pollIntervalMilliseconds: 5,
      timeoutMilliseconds: 500,
    });

    await writeFile(activePortPath, "43123\n/devtools/browser/ready\n", "utf8");

    await expect(pendingEndpoint).resolves.toMatchObject({ port: 43_123 });
  });

  it("reports an early process exit and its captured output immediately", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "process.stderr.write('browser failed'); process.exit(23)"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const processObservation = observeProcess(child, "Navegador");
    await once(child, "close");

    const directory = await createTemporaryDirectory();
    await expect(
      waitForDevToolsEndpoint(directory, processObservation, {
        timeoutMilliseconds: 500,
      }),
    ).rejects.toThrow(/Navegador encerrou com código 23[\s\S]*browser failed/u);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codex-visual-runtime-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function healthyProcessObservation(): ObservedProcess {
  return {
    diagnostics: () => "Saída capturada: (vazia)",
    failure: () => undefined,
  };
}
