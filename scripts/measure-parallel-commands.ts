import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const COMMAND_COUNT = 4;
const COMMAND_DELAY_MILLISECONDS = 180;
const SAMPLE_COUNT = 5;
const WARMUP_COUNT = 1;

interface Measurement {
  readonly parallelMilliseconds: number;
  readonly sequentialMilliseconds: number;
}

async function runIndependentCommand(index: number): Promise<string> {
  const expected = `command-${index}`;
  const script = `Start-Sleep -Milliseconds ${COMMAND_DELAY_MILLISECONDS}; [Console]::Out.Write('${expected}')`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pwsh",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: {
          ...process.env,
          CLICOLOR: "0",
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          TERM: "dumb",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      const error = Buffer.concat(stderr).toString("utf8").trim();
      if (exitCode !== 0) {
        reject(new Error(`PowerShell command ${index} exited with ${exitCode}: ${error}`));
        return;
      }
      const output = Buffer.concat(stdout).toString("utf8");
      if (output !== expected) {
        reject(
          new Error(
            `PowerShell command ${index} returned ${JSON.stringify(output)} instead of ${JSON.stringify(expected)}.`,
          ),
        );
        return;
      }
      resolve(output);
    });
  });
}

async function measureSequential(): Promise<number> {
  const startedAt = performance.now();
  const outputs: string[] = [];
  for (let index = 0; index < COMMAND_COUNT; index += 1) {
    outputs.push(await runIndependentCommand(index));
  }
  assertProviderOrder(outputs);
  return performance.now() - startedAt;
}

async function measureParallel(): Promise<number> {
  const startedAt = performance.now();
  const outputs = await Promise.all(
    Array.from({ length: COMMAND_COUNT }, (_, index) => runIndependentCommand(index)),
  );
  assertProviderOrder(outputs);
  return performance.now() - startedAt;
}

function assertProviderOrder(outputs: readonly string[]): void {
  const expected = Array.from({ length: COMMAND_COUNT }, (_, index) => `command-${index}`);
  if (outputs.length !== expected.length || outputs.some((output, index) => output !== expected[index])) {
    throw new Error(
      `Concurrent command outputs lost provider order: ${JSON.stringify({ expected, outputs })}`,
    );
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (value === undefined) {
    throw new Error("Cannot calculate a median without measurements.");
  }
  return value;
}

for (let index = 0; index < WARMUP_COUNT; index += 1) {
  await measureSequential();
  await measureParallel();
}

const measurements: Measurement[] = [];
for (let index = 0; index < SAMPLE_COUNT; index += 1) {
  const parallelFirst = index % 2 === 1;
  const parallelMilliseconds = parallelFirst ? await measureParallel() : undefined;
  const sequentialMilliseconds = await measureSequential();
  measurements.push({
    parallelMilliseconds: parallelMilliseconds ?? (await measureParallel()),
    sequentialMilliseconds,
  });
}

const sequentialMedian = median(
  measurements.map((measurement) => measurement.sequentialMilliseconds),
);
const parallelMedian = median(measurements.map((measurement) => measurement.parallelMilliseconds));
const acceleration = sequentialMedian / parallelMedian;
if (!(parallelMedian < sequentialMedian)) {
  throw new Error(
    `Parallel execution did not reduce wall time: ${JSON.stringify({
      parallelMedian,
      sequentialMedian,
    })}`,
  );
}

console.log(
  JSON.stringify(
    {
      acceleration,
      commandCount: COMMAND_COUNT,
      commandDelayMilliseconds: COMMAND_DELAY_MILLISECONDS,
      measurements,
      parallelMedianMilliseconds: parallelMedian,
      sampleCount: SAMPLE_COUNT,
      sequentialMedianMilliseconds: sequentialMedian,
    },
    null,
    2,
  ),
);
