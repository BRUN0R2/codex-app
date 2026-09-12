import type {
  CodexThread,
  FileChange,
  FileChangeKind,
  PlanStepStatus,
  ThreadAgentSummary,
  ThreadForkResponse,
  ThreadItem,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  ThreadStatus,
  ThreadSummary,
  ThreadTurn,
  ThreadUnarchiveResponse,
  TokenUsage,
  ToolOutputPresentation,
  TurnStartResponse,
  UserContent,
} from "../types";
import {
  ACTIVITY_STATUSES,
  CONVERSATION_MODES,
  IMAGE_DETAILS,
  MESSAGE_PHASES,
  PLAN_STEP_STATUSES,
  REASONING_EFFORTS,
  TERMINAL_TURN_STATUSES,
  TURN_STATUSES,
} from "./constants";
import { decodeModelContextWindow } from "./models";
import {
  array,
  ContractError,
  decodeCommandLiveOutput,
  exactRecord,
  field,
  identifier,
  integer,
  literal,
  MAX_STRING_BYTES,
  nullableDecimalCursor,
  nullableText,
  nullableThreadHistoryCursor,
  nullableThreadOutput,
  record,
  text,
} from "./primitives";

export function decodeThreadStartResponse(value: unknown): ThreadStartResponse {
  const object = exactRecord(value, "$", ["nextCursor", "thread"]);
  return decodeThreadPage(object);
}

export function decodeThreadForkResponse(value: unknown): ThreadForkResponse {
  const object = exactRecord(value, "$", ["nextCursor", "thread"]);
  return decodeThreadPage(object);
}

export function decodeThreadUnarchiveResponse(value: unknown): ThreadUnarchiveResponse {
  const object = exactRecord(value, "$", ["nextCursor", "thread"]);
  return decodeThreadPage(object);
}

export function decodeThreadListResponse(value: unknown): ThreadListResponse {
  const object = exactRecord(value, "$", ["data", "nextCursor"]);
  return {
    data: array(object.data, "$.data", decodeThreadSummary),
    nextCursor: nullableDecimalCursor(object.nextCursor, "$.nextCursor", "thread list"),
  };
}

export function decodeThreadReadResponse(value: unknown): ThreadReadResponse {
  const object = exactRecord(value, "$", ["agentThreads", "nextCursor", "thread"]);
  return {
    ...decodeThreadPage(object),
    agentThreads: array(object.agentThreads, "$.agentThreads", decodeThreadSummary),
  };
}

export function decodeThreadResumeResponse(value: unknown): ThreadResumeResponse {
  const object = exactRecord(value, "$", ["agentThreads", "cwd", "nextCursor", "thread"]);
  return {
    thread: decodeThread(object.thread, "$.thread"),
    cwd: text(object.cwd, "$.cwd"),
    nextCursor: nullableThreadHistoryCursor(object.nextCursor, "$.nextCursor"),
    agentThreads: array(object.agentThreads, "$.agentThreads", decodeThreadSummary),
  };
}

export function decodeThreadPage(value: {
  readonly nextCursor: unknown;
  readonly thread: unknown;
}): ThreadStartResponse {
  return {
    thread: decodeThread(value.thread, "$.thread"),
    nextCursor: nullableThreadHistoryCursor(value.nextCursor, "$.nextCursor"),
  };
}

export function decodeTurnStartResponse(value: unknown): TurnStartResponse {
  const object = exactRecord(value, "$", ["turn"]);
  return { turn: decodeTurnSummary(object.turn, "$.turn") };
}

export const THREAD_SUMMARY_KEYS = [
  "agent",
  "createdAt",
  "cwd",
  "id",
  "mode",
  "name",
  "preview",
  "projectPath",
  "recencyAt",
  "status",
  "updatedAt",
] as const;

export function decodeThreadSummary(value: unknown, path: string): ThreadSummary {
  return decodeThreadSummaryRecord(exactRecord(value, path, THREAD_SUMMARY_KEYS), path);
}

export function decodeThread(value: unknown, path: string): CodexThread {
  const object = exactRecord(value, path, [...THREAD_SUMMARY_KEYS, "turns"]);
  return {
    ...decodeThreadSummaryRecord(object, path),
    turns: array(object.turns, `${path}.turns`, decodeThreadTurn),
  };
}

export function decodeThreadSummaryRecord(
  object: Record<(typeof THREAD_SUMMARY_KEYS)[number], unknown>,
  path: string,
): ThreadSummary {
  const createdAt = integer(object.createdAt, `${path}.createdAt`, 0, Number.MAX_SAFE_INTEGER);
  const updatedAt = integer(object.updatedAt, `${path}.updatedAt`, 0, Number.MAX_SAFE_INTEGER);
  if (updatedAt < createdAt) {
    throw new ContractError(path, "thread updatedAt must not precede createdAt");
  }
  const recencyAt =
    object.recencyAt === null
      ? null
      : integer(object.recencyAt, `${path}.recencyAt`, 0, Number.MAX_SAFE_INTEGER);
  if (recencyAt !== null && recencyAt < createdAt) {
    throw new ContractError(path, "thread recencyAt must not precede createdAt");
  }
  return {
    id: identifier(object.id, `${path}.id`),
    mode: literal(object.mode, `${path}.mode`, CONVERSATION_MODES),
    preview: text(object.preview, `${path}.preview`, 512, true),
    name: nullableText(object.name, `${path}.name`),
    cwd: text(object.cwd, `${path}.cwd`, 4_096),
    projectPath: nullableText(object.projectPath, `${path}.projectPath`),
    createdAt,
    updatedAt,
    recencyAt,
    status: decodeThreadStatus(object.status, `${path}.status`),
    agent: object.agent === null ? null : decodeThreadAgentSummary(object.agent, `${path}.agent`),
  };
}

export function decodeThreadAgentSummary(value: unknown, path: string): ThreadAgentSummary {
  const object = exactRecord(value, path, [
    "model",
    "parentThreadId",
    "path",
    "reasoningEffort",
    "rootThreadId",
    "serviceTier",
    "taskName",
  ]);
  return {
    rootThreadId: identifier(object.rootThreadId, `${path}.rootThreadId`),
    parentThreadId: identifier(object.parentThreadId, `${path}.parentThreadId`),
    path: text(object.path, `${path}.path`, 4_096),
    taskName: text(object.taskName, `${path}.taskName`, 256),
    model: text(object.model, `${path}.model`, 256),
    reasoningEffort:
      object.reasoningEffort === null
        ? null
        : literal(object.reasoningEffort, `${path}.reasoningEffort`, REASONING_EFFORTS),
    serviceTier: nullableText(object.serviceTier, `${path}.serviceTier`),
  };
}

export function decodeThreadStatus(value: unknown, path: string): ThreadStatus {
  const object = record(value, path);
  const type = text(field(object, "type"), `${path}.type`, 32);
  switch (type) {
    case "active": {
      const active = exactRecord(object, path, ["activeFlags", "type"]);
      return {
        type,
        activeFlags: array(active.activeFlags, `${path}.activeFlags`, (entry, entryPath) =>
          literal(entry, entryPath, ["waitingOnApproval"] as const),
        ),
      };
    }
    case "idle":
    case "systemError": {
      exactRecord(object, path, ["type"]);
      return { type };
    }
    default:
      throw new ContractError(`${path}.type`, `unsupported thread status ${JSON.stringify(type)}`);
  }
}

export function decodeThreadTurn(value: unknown, path: string): ThreadTurn {
  const object = exactRecord(value, path, [
    "createdAt",
    "error",
    "id",
    "items",
    "status",
    "updatedAt",
  ]);
  const status = literal(object.status, `${path}.status`, TURN_STATUSES);
  const error = nullableText(object.error, `${path}.error`);
  if ((status === "failed") !== (error !== null)) {
    throw new ContractError(
      path,
      "failed turns require an error and all other turn states must not contain one",
    );
  }
  const createdAt = integer(object.createdAt, `${path}.createdAt`, 0, Number.MAX_SAFE_INTEGER);
  const updatedAt = integer(object.updatedAt, `${path}.updatedAt`, 0, Number.MAX_SAFE_INTEGER);
  if (updatedAt < createdAt) {
    throw new ContractError(path, "turn updatedAt must not precede createdAt");
  }
  return {
    id: identifier(object.id, `${path}.id`),
    items: array(object.items, `${path}.items`, decodeThreadItem),
    status,
    error,
    createdAt,
    updatedAt,
  };
}

export function decodeThreadItem(value: unknown, path: string): ThreadItem {
  const object = record(value, path);
  const type = text(field(object, "type"), `${path}.type`, 64);
  switch (type) {
    case "contextUsage": {
      const item = exactRecord(object, path, ["contextWindow", "id", "model", "type", "usage"]);
      return {
        type,
        id: identifier(item.id, `${path}.id`),
        model: identifier(item.model, `${path}.model`),
        usage: decodeTokenUsage(item.usage, `${path}.usage`),
        contextWindow:
          item.contextWindow === null
            ? null
            : decodeModelContextWindow(item.contextWindow, `${path}.contextWindow`),
      };
    }
    case "contextCompaction": {
      const item = exactRecord(object, path, ["id", "type"]);
      return {
        type,
        id: identifier(item.id, `${path}.id`),
      };
    }
    case "userMessage": {
      const item = exactRecord(object, path, ["content", "id", "type"]);
      return {
        type,
        id: identifier(item.id, `${path}.id`),
        content: array(item.content, `${path}.content`, decodeUserContent, 12),
      };
    }
    case "agentMessage": {
      const item = exactRecord(object, path, ["id", "phase", "text", "type"]);
      return {
        type,
        id: identifier(item.id, `${path}.id`),
        text: text(item.text, `${path}.text`, MAX_STRING_BYTES, true),
        phase: item.phase === null ? null : literal(item.phase, `${path}.phase`, MESSAGE_PHASES),
      };
    }
    case "reasoning": {
      const item = exactRecord(object, path, ["content", "id", "summary", "type"]);
      return {
        type,
        id: identifier(item.id, `${path}.id`),
        summary: array(item.summary, `${path}.summary`, (entry, entryPath) =>
          text(entry, entryPath, MAX_STRING_BYTES, true),
        ),
        content: array(item.content, `${path}.content`, (entry, entryPath) =>
          text(entry, entryPath, MAX_STRING_BYTES, true),
        ),
      };
    }
    case "plan": {
      const item = exactRecord(object, path, ["explanation", "id", "steps", "type"]);
      const steps = array(
        item.steps,
        `${path}.steps`,
        (value, stepPath) => {
          const step = exactRecord(value, stepPath, ["status", "step"]);
          return {
            step: text(step.step, `${stepPath}.step`, 1_024),
            status: literal(
              step.status,
              `${stepPath}.status`,
              PLAN_STEP_STATUSES,
            ) satisfies PlanStepStatus,
          };
        },
        20,
      );
      if (steps.length === 0) {
        throw new ContractError(`${path}.steps`, "plan must contain at least one step");
      }
      if (steps.filter((step) => step.status === "inProgress").length > 1) {
        throw new ContractError(
          `${path}.steps`,
          "plan must not contain more than one in-progress step",
        );
      }
      const uniqueSteps = new Set(steps.map((step) => step.step.toLowerCase()));
      if (uniqueSteps.size !== steps.length) {
        throw new ContractError(`${path}.steps`, "plan steps must be unique");
      }
      return {
        type,
        id: identifier(item.id, `${path}.id`),
        explanation:
          item.explanation === null ? null : text(item.explanation, `${path}.explanation`, 4_096),
        steps,
      };
    }
    case "commandExecution": {
      const item = exactRecord(object, path, [
        "aggregatedOutput",
        "command",
        "cwd",
        "durationMs",
        "exitCode",
        "id",
        "liveOutput",
        "processId",
        "source",
        "startedAt",
        "status",
        "type",
      ]);
      return {
        type,
        id: identifier(item.id, `${path}.id`),
        command: text(item.command, `${path}.command`, 16_384),
        cwd: text(item.cwd, `${path}.cwd`, 4_096),
        processId: nullableText(item.processId, `${path}.processId`),
        startedAt:
          item.startedAt === null
            ? null
            : integer(item.startedAt, `${path}.startedAt`, 0, Number.MAX_SAFE_INTEGER),
        source: literal(item.source, `${path}.source`, ["agent"] as const),
        status: literal(item.status, `${path}.status`, ACTIVITY_STATUSES),
        aggregatedOutput: nullableThreadOutput(item.aggregatedOutput, `${path}.aggregatedOutput`),
        liveOutput:
          item.liveOutput === null
            ? null
            : decodeCommandLiveOutput(item.liveOutput, `${path}.liveOutput`),
        exitCode:
          item.exitCode === null
            ? null
            : integer(item.exitCode, `${path}.exitCode`, -2_147_483_648, 2_147_483_647),
        durationMs:
          item.durationMs === null
            ? null
            : integer(item.durationMs, `${path}.durationMs`, 0, Number.MAX_SAFE_INTEGER),
      };
    }
    case "fileChange": {
      const item = exactRecord(object, path, ["changes", "id", "status", "type"]);
      return {
        type,
        id: identifier(item.id, `${path}.id`),
        changes: array(item.changes, `${path}.changes`, decodeFileChange, 1_000),
        status: literal(item.status, `${path}.status`, ACTIVITY_STATUSES),
      };
    }
    case "toolExecution": {
      const item = exactRecord(object, path, [
        "description",
        "id",
        "name",
        "output",
        "outputPresentation",
        "status",
        "type",
      ]);
      return {
        type,
        id: identifier(item.id, `${path}.id`),
        name: identifier(item.name, `${path}.name`),
        description: text(item.description, `${path}.description`, 4_096),
        status: literal(item.status, `${path}.status`, ACTIVITY_STATUSES),
        outputPresentation: decodeToolOutputPresentation(
          item.outputPresentation,
          `${path}.outputPresentation`,
        ),
        output: nullableThreadOutput(item.output, `${path}.output`),
      };
    }
    default:
      throw new ContractError(`${path}.type`, `unsupported item ${JSON.stringify(type)}`);
  }
}

export function decodeTokenUsage(value: unknown, path: string): TokenUsage {
  const object = exactRecord(value, path, [
    "cachedInputTokens",
    "inputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ]);
  const inputTokens = integer(object.inputTokens, `${path}.inputTokens`, 0, 1_000_000_000);
  const cachedInputTokens = integer(
    object.cachedInputTokens,
    `${path}.cachedInputTokens`,
    0,
    inputTokens,
  );
  const outputTokens = integer(object.outputTokens, `${path}.outputTokens`, 0, 1_000_000_000);
  const reasoningOutputTokens = integer(
    object.reasoningOutputTokens,
    `${path}.reasoningOutputTokens`,
    0,
    outputTokens,
  );
  const totalTokens = integer(object.totalTokens, `${path}.totalTokens`, 0, 1_000_000_000);
  if (totalTokens !== inputTokens + outputTokens) {
    throw new ContractError(`${path}.totalTokens`, "must equal inputTokens plus outputTokens");
  }
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

export function decodeUserContent(value: unknown, path: string): UserContent {
  const object = record(value, path);
  const type = text(field(object, "type"), `${path}.type`, 32);
  switch (type) {
    case "text": {
      const content = exactRecord(object, path, ["text", "type"]);
      return { type, text: text(content.text, `${path}.text`, MAX_STRING_BYTES) };
    }
    case "localImage": {
      const content = exactRecord(object, path, ["detail", "path", "type"]);
      return {
        type,
        path: text(content.path, `${path}.path`, 4_096),
        detail:
          content.detail === null ? null : literal(content.detail, `${path}.detail`, IMAGE_DETAILS),
      };
    }
    case "mention": {
      const content = exactRecord(object, path, ["name", "path", "type"]);
      return {
        type,
        name: text(content.name, `${path}.name`, 1_024),
        path: text(content.path, `${path}.path`, 4_096),
      };
    }
    default:
      throw new ContractError(`${path}.type`, `unsupported user content ${JSON.stringify(type)}`);
  }
}

export const FILE_CHANGE_KEYS = ["diff", "kind", "lineStats", "path"] as const;
export const FILE_CHANGE_LINE_STATS_KEYS = ["additions", "deletions"] as const;
export const FILE_CHANGE_KIND_KEYS = ["movePath", "type"] as const;
export const FILE_CHANGE_SIMPLE_KIND_KEYS = ["type"] as const;

export function decodeFileChange(value: unknown, path: string): FileChange {
  const object = exactRecord(value, path, FILE_CHANGE_KEYS);
  return {
    path: text(object.path, `${path}.path`, 4_096),
    kind: decodeFileChangeKind(object.kind, `${path}.kind`),
    diff: text(object.diff, `${path}.diff`, MAX_STRING_BYTES, true),
    lineStats:
      object.lineStats === null
        ? null
        : decodeFileChangeLineStats(object.lineStats, `${path}.lineStats`),
  };
}

export function decodeFileChangeLineStats(value: unknown, path: string) {
  const object = exactRecord(value, path, FILE_CHANGE_LINE_STATS_KEYS);
  return {
    additions: integer(object.additions, `${path}.additions`, 0, 1_000_000_000),
    deletions: integer(object.deletions, `${path}.deletions`, 0, 1_000_000_000),
  };
}

export function decodeFileChangeKind(value: unknown, path: string): FileChangeKind {
  const object = record(value, path);
  const type = text(field(object, "type"), `${path}.type`, 16);
  switch (type) {
    case "add":
    case "delete": {
      exactRecord(object, path, FILE_CHANGE_SIMPLE_KIND_KEYS);
      return { type };
    }
    case "update": {
      const change = exactRecord(object, path, FILE_CHANGE_KIND_KEYS);
      return { type, movePath: nullableText(change.movePath, `${path}.movePath`) };
    }
    default:
      throw new ContractError(`${path}.type`, `unsupported file change ${JSON.stringify(type)}`);
  }
}

export function decodeToolOutputPresentation(value: unknown, path: string): ToolOutputPresentation {
  const object = record(value, path);
  const type = text(field(object, "type"), `${path}.type`, 32);
  switch (type) {
    case "fileList":
    case "image":
    case "plainText":
    case "searchResults":
      exactRecord(object, path, ["type"]);
      return { type };
    case "sourceFile": {
      const presentation = exactRecord(object, path, ["path", "type"]);
      return {
        type,
        path: text(presentation.path, `${path}.path`, 4_096),
      };
    }
    default:
      throw new ContractError(
        `${path}.type`,
        `unsupported tool output presentation ${JSON.stringify(type)}`,
      );
  }
}

export function decodeTurnSummary(value: unknown, path: string) {
  const object = exactRecord(value, path, ["createdAt", "id", "status", "updatedAt"]);
  const createdAt = integer(object.createdAt, `${path}.createdAt`, 0, Number.MAX_SAFE_INTEGER);
  const updatedAt = integer(object.updatedAt, `${path}.updatedAt`, 0, Number.MAX_SAFE_INTEGER);
  if (updatedAt < createdAt) {
    throw new ContractError(path, "turn updatedAt must not precede createdAt");
  }
  return {
    id: identifier(object.id, `${path}.id`),
    status: literal(object.status, `${path}.status`, TURN_STATUSES),
    createdAt,
    updatedAt,
  };
}

export function decodeCompletedTurn(value: unknown, path: string) {
  const object = exactRecord(value, path, ["error", "id", "status", "updatedAt"]);
  return {
    id: identifier(object.id, `${path}.id`),
    status: literal(object.status, `${path}.status`, TERMINAL_TURN_STATUSES),
    error: nullableText(object.error, `${path}.error`),
    updatedAt: integer(object.updatedAt, `${path}.updatedAt`, 0, Number.MAX_SAFE_INTEGER),
  };
}
