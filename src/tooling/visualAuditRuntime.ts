import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_POLL_INTERVAL_MILLISECONDS = 100;
const DEFAULT_TIMEOUT_MILLISECONDS = 20_000;
const MAX_CAPTURED_OUTPUT_CHARACTERS = 16_384;
const DEVTOOLS_ACTIVE_PORT_FILE = "DevToolsActivePort";

export interface DevToolsEndpoint {
  readonly browserWebSocketUrl: string;
  readonly port: number;
  readonly versionUrl: string;
}

export interface ObservedProcess {
  readonly diagnostics: () => string;
  readonly failure: () => string | undefined;
}

export interface ReadinessOptions {
  readonly pollIntervalMilliseconds?: number;
  readonly timeoutMilliseconds?: number;
}

interface WaitSettings {
  readonly pollIntervalMilliseconds: number;
  readonly timeoutMilliseconds: number;
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
      ? "Saída capturada: (vazia)"
      : `Saída capturada:\n${normalizedOutput}`;
  };

  return {
    diagnostics,
    failure: () => {
      if (spawnError !== undefined) {
        return `${label} não pôde ser iniciado: ${spawnError.message}\n${diagnostics()}`;
      }
      if (child.exitCode !== null) {
        return `${label} encerrou com código ${child.exitCode} antes de ficar pronto.\n${diagnostics()}`;
      }
      if (child.signalCode !== null) {
        return `${label} encerrou com o sinal ${child.signalCode} antes de ficar pronto.\n${diagnostics()}`;
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
    throw new Error("DevToolsActivePort não contém a porta e o endpoint do navegador.");
  }
  if (!/^\d+$/u.test(portText)) {
    throw new Error(`Porta inválida em DevToolsActivePort: ${portText}`);
  }

  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Porta fora do intervalo válido em DevToolsActivePort: ${portText}`);
  }
  if (!browserWebSocketPath.startsWith("/devtools/browser/")) {
    throw new Error(`Endpoint inválido em DevToolsActivePort: ${browserWebSocketPath}`);
  }

  return {
    browserWebSocketUrl: `ws://127.0.0.1:${port}${browserWebSocketPath}`,
    port,
    versionUrl: `http://127.0.0.1:${port}/json/version`,
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
  let lastFailure = "o arquivo ainda não foi criado";

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
    `Tempo esgotado aguardando ${activePortPath}. Última falha: ${lastFailure}\n${processObservation.diagnostics()}`,
  );
}

export async function waitForHttp(
  url: string,
  processObservation: ObservedProcess,
  options: ReadinessOptions = {},
): Promise<void> {
  const settings = resolveWaitSettings(options);
  const deadline = Date.now() + settings.timeoutMilliseconds;
  let lastFailure = "nenhuma resposta recebida";

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
    `Tempo esgotado aguardando ${url}. Última falha: ${lastFailure}\n${processObservation.diagnostics()}`,
  );
}

function assertProcessRunning(processObservation: ObservedProcess, target: string): void {
  const failure = processObservation.failure();
  if (failure !== undefined) {
    throw new Error(`${failure}\nRecurso aguardado: ${target}`);
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
    throw new TypeError(`${name} deve ser um inteiro positivo.`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
