import type { Automation, AutomationListResponse, AutomationRun } from "../types";
import {
  AUTOMATION_INTERVAL_MAXIMUM_MINUTES,
  AUTOMATION_INTERVAL_MINIMUM_MINUTES,
  array,
  booleanValue,
  ContractError,
  exactRecord,
  identifier,
  integer,
  literal,
  nullableText,
  TIMEZONE_OFFSET_MAXIMUM_MINUTES,
  TIMEZONE_OFFSET_MINIMUM_MINUTES,
  text,
} from "./primitives";

export function decodeAutomationListResponse(value: unknown): AutomationListResponse {
  const object = exactRecord(value, "$", ["data", "runs"]);
  const data = array(object.data, "$.data", decodeAutomationAt, 1_000);
  const ids = new Set<string>();
  for (const automation of data) {
    if (ids.has(automation.id)) {
      throw new ContractError("$.data", `duplicate automation id ${JSON.stringify(automation.id)}`);
    }
    ids.add(automation.id);
  }
  const runs = array(object.runs, "$.runs", decodeAutomationRunAt, 200);
  const runIds = new Set<string>();
  for (const run of runs) {
    if (runIds.has(run.id)) {
      throw new ContractError("$.runs", `duplicate automation run id ${JSON.stringify(run.id)}`);
    }
    if (!ids.has(run.automationId)) {
      throw new ContractError(
        "$.runs",
        `automation run references unknown automation ${JSON.stringify(run.automationId)}`,
      );
    }
    runIds.add(run.id);
  }
  return { data, runs };
}

export function decodeAutomation(value: unknown): Automation {
  return decodeAutomationAt(value, "$");
}

export function decodeAutomationRun(value: unknown): AutomationRun {
  return decodeAutomationRunAt(value, "$");
}

export function decodeAutomationAt(value: unknown, path: string): Automation {
  const object = exactRecord(value, path, [
    "createdAt",
    "enabled",
    "id",
    "intervalMinutes",
    "lastRunAt",
    "name",
    "nextRunAt",
    "projectPath",
    "prompt",
    "timezone",
    "timezoneOffsetMin",
    "updatedAt",
    "version",
  ]);
  const createdAt = integer(object.createdAt, `${path}.createdAt`, 0, Number.MAX_SAFE_INTEGER);
  const updatedAt = integer(object.updatedAt, `${path}.updatedAt`, 0, Number.MAX_SAFE_INTEGER);
  if (updatedAt < createdAt) {
    throw new ContractError(path, "automation updatedAt must not precede createdAt");
  }
  const enabled = booleanValue(object.enabled, `${path}.enabled`);
  const nextRunAt =
    object.nextRunAt === null
      ? null
      : integer(object.nextRunAt, `${path}.nextRunAt`, 0, Number.MAX_SAFE_INTEGER);
  if (enabled !== (nextRunAt !== null)) {
    throw new ContractError(path, "enabled automations require a nextRunAt timestamp");
  }
  const lastRunAt =
    object.lastRunAt === null
      ? null
      : integer(object.lastRunAt, `${path}.lastRunAt`, 0, Number.MAX_SAFE_INTEGER);
  return {
    id: identifier(object.id, `${path}.id`),
    name: text(object.name, `${path}.name`, 160),
    prompt: text(object.prompt, `${path}.prompt`, 262_144),
    projectPath:
      object.projectPath === null ? null : text(object.projectPath, `${path}.projectPath`, 4_096),
    enabled,
    intervalMinutes: integer(
      object.intervalMinutes,
      `${path}.intervalMinutes`,
      AUTOMATION_INTERVAL_MINIMUM_MINUTES,
      AUTOMATION_INTERVAL_MAXIMUM_MINUTES,
    ),
    timezone: text(object.timezone, `${path}.timezone`, 128),
    timezoneOffsetMin: integer(
      object.timezoneOffsetMin,
      `${path}.timezoneOffsetMin`,
      TIMEZONE_OFFSET_MINIMUM_MINUTES,
      TIMEZONE_OFFSET_MAXIMUM_MINUTES,
    ),
    nextRunAt,
    lastRunAt,
    version: integer(object.version, `${path}.version`, 1, Number.MAX_SAFE_INTEGER),
    createdAt,
    updatedAt,
  };
}

export function decodeAutomationRunAt(value: unknown, path: string): AutomationRun {
  const object = exactRecord(value, path, [
    "automationId",
    "completedAt",
    "createdAt",
    "error",
    "id",
    "reviewed",
    "startedAt",
    "status",
    "threadId",
    "trigger",
    "turnId",
  ]);
  const status = literal(object.status, `${path}.status`, [
    "completed",
    "failed",
    "interrupted",
    "queued",
    "running",
  ] as const);
  const createdAt = integer(object.createdAt, `${path}.createdAt`, 0, Number.MAX_SAFE_INTEGER);
  const startedAt =
    object.startedAt === null
      ? null
      : integer(object.startedAt, `${path}.startedAt`, createdAt, Number.MAX_SAFE_INTEGER);
  const completedAt =
    object.completedAt === null
      ? null
      : integer(object.completedAt, `${path}.completedAt`, createdAt, Number.MAX_SAFE_INTEGER);
  const terminal = status === "completed" || status === "failed" || status === "interrupted";
  if (terminal !== (completedAt !== null)) {
    throw new ContractError(path, "terminal automation runs require completedAt");
  }
  if (status === "running" && startedAt === null) {
    throw new ContractError(path, "running automation runs require startedAt");
  }
  if (status === "queued" && startedAt !== null) {
    throw new ContractError(path, "queued automation runs cannot contain startedAt");
  }
  if (startedAt !== null && completedAt !== null && completedAt < startedAt) {
    throw new ContractError(path, "automation completedAt must not precede startedAt");
  }
  const error = nullableText(object.error, `${path}.error`, 16_384);
  if (status === "failed" && error === null) {
    throw new ContractError(path, "failed automation runs require an error");
  }
  if ((status === "completed" || status === "queued" || status === "running") && error !== null) {
    throw new ContractError(path, "this automation run status cannot contain an error");
  }
  const reviewed = booleanValue(object.reviewed, `${path}.reviewed`);
  if (reviewed && !terminal) {
    throw new ContractError(path, "active automation runs cannot be reviewed");
  }
  const threadId =
    object.threadId === null ? null : identifier(object.threadId, `${path}.threadId`);
  const turnId = object.turnId === null ? null : identifier(object.turnId, `${path}.turnId`);
  if (turnId !== null && threadId === null) {
    throw new ContractError(path, "an automation turn requires its thread reference");
  }
  return {
    id: identifier(object.id, `${path}.id`),
    automationId: identifier(object.automationId, `${path}.automationId`),
    trigger: literal(object.trigger, `${path}.trigger`, ["manual", "scheduled"] as const),
    status,
    threadId,
    turnId,
    error,
    reviewed,
    createdAt,
    startedAt,
    completedAt,
  };
}
