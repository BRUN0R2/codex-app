import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";

const DEFAULT_POLL_INTERVAL_MILLISECONDS = 100;
const DEFAULT_TIMEOUT_MILLISECONDS = 20_000;
const MAX_CAPTURED_OUTPUT_CHARACTERS = 16_384;
const DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort";

export interface DevToolsEndpoint {
  readonly browserWebSocketUrl: string;
  readonly port: number;
}

export interface ObservedProcess {
  readonly diagnostics: () => string;
  readonly failure: () => string | undefined;
}

export interface ReadinessOptions {
  readonly pollIntervalMilliseconds?: number;
  readonly timeoutMilliseconds?: number;
}

export interface RetainedIdentityComparison {
  readonly replacementCount: number;
  readonly retainedCount: number;
}

export function chromiumAuditArguments(userDataDirectory: string): readonly string[] {
  if (!path.isAbsolute(userDataDirectory)) {
    throw new Error("The temporary browser profile must use an absolute path.");
  }
  return [
    "--headless=new",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-breakpad",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-features=Translate",
    "--disable-renderer-backgrounding",
    "--disable-sync",
    "--edge-skip-compat-layer-relaunch",
    "--enable-smooth-scrolling",
    "--force-prefers-no-reduced-motion",
    "--hide-scrollbars",
    "--metrics-recording-only",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDirectory}`,
    "about:blank",
  ];
}

export function loopbackHttpOrigin(address: AddressInfo | string | null): string {
  if (address === null || typeof address === "string") {
    throw new Error("The visual server did not publish a TCP address.");
  }
  if (!Number.isSafeInteger(address.port) || address.port < 1 || address.port > 65_535) {
    throw new Error(`The visual server published an invalid port: ${address.port}.`);
  }
  return `http://127.0.0.1:${address.port}`;
}

interface WaitSettings {
  readonly pollIntervalMilliseconds: number;
  readonly timeoutMilliseconds: number;
}

export function compareRetainedIdentities<TIdentity extends object>(
  previous: ReadonlyMap<string, TIdentity>,
  current: ReadonlyMap<string, TIdentity>,
): RetainedIdentityComparison {
  let replacementCount = 0;
  let retainedCount = 0;

  for (const [key, currentIdentity] of current) {
    const previousIdentity = previous.get(key);
    if (previousIdentity === undefined) {
      continue;
    }
    retainedCount += 1;
    replacementCount += previousIdentity === currentIdentity ? 0 : 1;
  }

  return { replacementCount, retainedCount };
}

export function observeProcess(child: ChildProcess, label: string): ObservedProcess {
  let output = "";
  let spawnError: Error | undefined;
  const append = (chunk: Buffer | string): void => {
    output = `${output}${chunk.toString()}`.slice(-MAX_CAPTURED_OUTPUT_CHARACTERS);
  };

  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.once("error", (error: Error) => {
    spawnError = error;
  });

  const diagnostics = (): string => {
    const normalizedOutput = output.trim();
    return normalizedOutput.length === 0
      ? "Captured output: (empty)"
      : `Captured output:\n${normalizedOutput}`;
  };

  return {
    diagnostics,
    failure: () => {
      if (spawnError !== undefined) {
        return `${label} could not be started: ${spawnError.message}\n${diagnostics()}`;
      }
      if (child.exitCode !== null && child.exitCode !== 0) {
        return `${label} exited with code ${child.exitCode} before becoming ready.\n${diagnostics()}`;
      }
      if (child.signalCode !== null) {
        return `${label} exited with signal ${child.signalCode} before becoming ready.\n${diagnostics()}`;
      }
      return undefined;
    },
  };
}

export function parseDevToolsActivePort(content: string): DevToolsEndpoint {
  const lines = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const portText = lines[0];
  const browserWebSocketPath = lines[1];

  if (portText === undefined || browserWebSocketPath === undefined) {
    throw new Error("DevToolsActivePort does not contain the browser port and endpoint.");
  }
  if (!/^\d+$/u.test(portText)) {
    throw new Error(`Invalid port in DevToolsActivePort: ${portText}`);
  }

  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Port outside the valid range in DevToolsActivePort: ${portText}`);
  }
  if (!browserWebSocketPath.startsWith("/devtools/browser/")) {
    throw new Error(`Invalid endpoint in DevToolsActivePort: ${browserWebSocketPath}`);
  }

  return {
    browserWebSocketUrl: `ws://127.0.0.1:${port}${browserWebSocketPath}`,
    port,
  };
}

export async function waitForDevToolsEndpoint(
  userDataDirectory: string,
  processObservation: ObservedProcess,
  options: ReadinessOptions = {},
): Promise<DevToolsEndpoint> {
  const settings = resolveWaitSettings(options);
  const activePortPath = path.join(userDataDirectory, DEVTOOLS_ACTIVE_PORT_FILE);
  const deadline = Date.now() + settings.timeoutMilliseconds;
  let lastFailure = "the file has not been created yet";

  while (Date.now() < deadline) {
    assertProcessRunning(processObservation, activePortPath);
    try {
      return parseDevToolsActivePort(await readFile(activePortPath, "utf8"));
    } catch (error: unknown) {
      lastFailure = describeError(error);
    }
    await delay(settings.pollIntervalMilliseconds);
  }

  assertProcessRunning(processObservation, activePortPath);
  throw new Error(
    `Timed out waiting for ${activePortPath}. Last failure: ${lastFailure}\n${processObservation.diagnostics()}`,
  );
}

export async function waitForHttp(
  url: string,
  processObservation: ObservedProcess,
  options: ReadinessOptions = {},
): Promise<void> {
  const settings = resolveWaitSettings(options);
  const deadline = Date.now() + settings.timeoutMilliseconds;
  let lastFailure = "no response received";

  while (Date.now() < deadline) {
    assertProcessRunning(processObservation, url);
    try {
      const remainingMilliseconds = Math.max(1, deadline - Date.now());
      const response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(1_000, remainingMilliseconds)),
      });
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) {
        return;
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error: unknown) {
      lastFailure = describeError(error);
    }
    await delay(settings.pollIntervalMilliseconds);
  }

  assertProcessRunning(processObservation, url);
  throw new Error(
    `Timed out waiting for ${url}. Last failure: ${lastFailure}\n${processObservation.diagnostics()}`,
  );
}

function assertProcessRunning(processObservation: ObservedProcess, target: string): void {
  const failure = processObservation.failure();
  if (failure !== undefined) {
    throw new Error(`${failure}\nAwaited resource: ${target}`);
  }
}

function resolveWaitSettings(options: ReadinessOptions): WaitSettings {
  const pollIntervalMilliseconds =
    options.pollIntervalMilliseconds ?? DEFAULT_POLL_INTERVAL_MILLISECONDS;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;

  assertPositiveFiniteInteger(pollIntervalMilliseconds, "pollIntervalMilliseconds");
  assertPositiveFiniteInteger(timeoutMilliseconds, "timeoutMilliseconds");
  return { pollIntervalMilliseconds, timeoutMilliseconds };
}

function assertPositiveFiniteInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
