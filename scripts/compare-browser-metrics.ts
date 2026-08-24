import { readFile } from "node:fs/promises";
import path from "node:path";

interface BrowserMetric {
  readonly action: string;
  readonly status: "completed" | "declined" | "failed";
  readonly totalMs: number;
  readonly queueMs: number;
  readonly actionMs: number;
  readonly loadMs: number;
  readonly snapshotMs: number;
  readonly screenshotMs: number;
}

interface MetricSummary {
  readonly samples: number;
  readonly failures: number;
  readonly failurePercent: number;
  readonly averageTotalMs: number;
  readonly medianTotalMs: number;
  readonly p95TotalMs: number;
  readonly averageQueueMs: number;
  readonly averageActionMs: number;
  readonly averageLoadMs: number;
  readonly averageSnapshotMs: number;
  readonly averageScreenshotMs: number;
}

interface ParsedArguments {
  readonly baseline: string;
  readonly candidate: string;
  readonly action: string | null;
}

const argumentsValue = parseArguments(process.argv.slice(2));
const [baseline, candidate] = await Promise.all([
  readMetrics(argumentsValue.baseline, argumentsValue.action),
  readMetrics(argumentsValue.candidate, argumentsValue.action),
]);
const baselineSummary = summarize(baseline);
const candidateSummary = summarize(candidate);

console.log(
  JSON.stringify(
    {
      action: argumentsValue.action,
      baseline: {
        path: path.resolve(argumentsValue.baseline),
        ...baselineSummary,
      },
      candidate: {
        path: path.resolve(argumentsValue.candidate),
        ...candidateSummary,
      },
      delta: {
        averageTotalMs: delta(candidateSummary.averageTotalMs, baselineSummary.averageTotalMs),
        medianTotalMs: delta(candidateSummary.medianTotalMs, baselineSummary.medianTotalMs),
        p95TotalMs: delta(candidateSummary.p95TotalMs, baselineSummary.p95TotalMs),
        averageQueueMs: delta(candidateSummary.averageQueueMs, baselineSummary.averageQueueMs),
        averageActionMs: delta(candidateSummary.averageActionMs, baselineSummary.averageActionMs),
        averageLoadMs: delta(candidateSummary.averageLoadMs, baselineSummary.averageLoadMs),
        averageSnapshotMs: delta(
          candidateSummary.averageSnapshotMs,
          baselineSummary.averageSnapshotMs,
        ),
        averageScreenshotMs: delta(
          candidateSummary.averageScreenshotMs,
          baselineSummary.averageScreenshotMs,
        ),
        failurePercentagePoints:
          candidateSummary.failurePercent - baselineSummary.failurePercent,
      },
    },
    null,
    2,
  ),
);

function parseArguments(args: readonly string[]): ParsedArguments {
  let baseline: string | null = null;
  let candidate: string | null = null;
  let action: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--") {
      continue;
    }
    const value = args[index + 1];
    if (flag === "--baseline" || flag === "--candidate" || flag === "--action") {
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      if (flag === "--baseline") baseline = value;
      if (flag === "--candidate") candidate = value;
      if (flag === "--action") action = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown browser metric argument ${JSON.stringify(flag)}`);
  }
  if (baseline === null || candidate === null) {
    throw new Error(
      "usage: pnpm measure:browser -- --baseline <before.jsonl> --candidate <after.jsonl> [--action click]",
    );
  }
  return { baseline, candidate, action };
}

async function readMetrics(filePath: string, action: string | null): Promise<BrowserMetric[]> {
  const source = await readFile(filePath, "utf8");
  const metrics: BrowserMetric[] = [];
  for (const [index, line] of source.split(/\r?\n/gu).entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${filePath}:${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const metric = decodeMetric(value, `${filePath}:${index + 1}`);
    if (action === null || metric.action === action) {
      metrics.push(metric);
    }
  }
  if (metrics.length === 0) {
    throw new Error(
      `${filePath} contains no browser metrics${action === null ? "" : ` for action ${JSON.stringify(action)}`}`,
    );
  }
  return metrics;
}

function decodeMetric(value: unknown, source: string): BrowserMetric {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must contain an object`);
  }
  const object = value as Record<string, unknown>;
  const status = object.status;
  if (status !== "completed" && status !== "declined" && status !== "failed") {
    throw new Error(`${source}.status is invalid`);
  }
  return {
    action: requiredString(object.action, `${source}.action`),
    status,
    totalMs: requiredDuration(object.totalMs, `${source}.totalMs`),
    queueMs: requiredDuration(object.queueMs, `${source}.queueMs`),
    actionMs: requiredDuration(object.actionMs, `${source}.actionMs`),
    loadMs: requiredDuration(object.loadMs, `${source}.loadMs`),
    snapshotMs: requiredDuration(object.snapshotMs, `${source}.snapshotMs`),
    screenshotMs: requiredDuration(object.screenshotMs, `${source}.screenshotMs`),
  };
}

function requiredString(value: unknown, source: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${source} must be a non-empty string`);
  }
  return value;
}

function requiredDuration(value: unknown, source: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${source} must be a non-negative finite number`);
  }
  return value;
}

function summarize(metrics: readonly BrowserMetric[]): MetricSummary {
  const totals = metrics.map((metric) => metric.totalMs).sort((left, right) => left - right);
  const failures = metrics.filter((metric) => metric.status === "failed").length;
  return {
    samples: metrics.length,
    failures,
    failurePercent: (failures / metrics.length) * 100,
    averageTotalMs: average(metrics.map((metric) => metric.totalMs)),
    medianTotalMs: percentile(totals, 0.5),
    p95TotalMs: percentile(totals, 0.95),
    averageQueueMs: average(metrics.map((metric) => metric.queueMs)),
    averageActionMs: average(metrics.map((metric) => metric.actionMs)),
    averageLoadMs: average(metrics.map((metric) => metric.loadMs)),
    averageSnapshotMs: average(metrics.map((metric) => metric.snapshotMs)),
    averageScreenshotMs: average(metrics.map((metric) => metric.screenshotMs)),
  };
}

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  const value = sorted[index];
  if (value === undefined) {
    throw new Error("cannot calculate a percentile for an empty metric series");
  }
  return value;
}

function delta(candidate: number, baseline: number): {
  readonly absolute: number;
  readonly percent: number | null;
} {
  return {
    absolute: candidate - baseline,
    percent: baseline === 0 ? null : ((candidate - baseline) / baseline) * 100,
  };
}
