import type { ActivityStatus, CommandLiveOutput, FileChange, TurnStatus } from "../contracts/types";
import { formatMessage, type TranslationMessages } from "../i18n/messages";

export type TimelineMessages = TranslationMessages["timeline"];

export type ReasoningItemState = "completed" | "streaming";
export type ThinkingPresentation = "activity" | "none" | "standalone";
export const LONG_COMMAND_DURATION_THRESHOLD_MS = 10_000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 60 * SECONDS_PER_MINUTE;
const USER_MESSAGE_PROXIMITY_WEIGHTS = {
  current: 25,
  adjacent: 20,
  nearby: 14,
  remote: 10,
  minimum: 7,
} as const;

export function thinkingPresentation(
  status: TurnStatus,
  finalAnswerStarted: boolean,
  latestWorkOwnsHeadline: boolean,
): ThinkingPresentation {
  if (status !== "inProgress" || finalAnswerStarted) {
    return "none";
  }
  return latestWorkOwnsHeadline ? "activity" : "standalone";
}

export function turnDurationLabel(
  status: TurnStatus,
  duration: string,
  messages: TimelineMessages,
): string {
  switch (status) {
    case "completed":
      return formatMessage(messages.workedFor, { duration });
    case "failed":
      return formatMessage(messages.failedAfter, { duration });
    case "inProgress":
      return formatMessage(messages.processingFor, { duration });
    case "interrupted":
      return formatMessage(messages.interruptedAfter, { duration });
  }
}

export function confirmedOutputTokenLabel(
  tokens: number,
  messages: TimelineMessages,
  locale: string,
): string {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new RangeError("The confirmed token count must be a non-negative safe integer.");
  }
  const count = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(tokens);
  return formatMessage(tokens === 1 ? messages.oneToken : messages.manyTokens, { count });
}

export function formatElapsedSeconds(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  if (totalSeconds < SECONDS_PER_MINUTE) {
    return `${totalSeconds} s`;
  }
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const remainder = totalSeconds % SECONDS_PER_MINUTE;
  if (hours === 0) {
    return `${minutes} min ${remainder} s`;
  }
  return `${hours} h ${minutes} min ${remainder} s`;
}

export function formatCompactElapsedSeconds(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  if (totalSeconds < SECONDS_PER_MINUTE) {
    return `${totalSeconds}s`;
  }
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const remainder = totalSeconds % SECONDS_PER_MINUTE;
  if (hours === 0) {
    return `${minutes}m ${remainder}s`;
  }
  return `${hours}h ${minutes}m ${remainder}s`;
}

export function runningCommandHeadline(
  duration: string | null,
  fallback: string,
  messages: TimelineMessages,
): string {
  return duration === null ? fallback : formatMessage(messages.runningCommandFor, { duration });
}

export function reasoningTitle(
  summary: readonly string[],
  state: ReasoningItemState,
): string | null {
  for (let index = summary.length - 1; index >= 0; index -= 1) {
    const part = summary[index];
    if (part === undefined || part.trim().length === 0) {
      continue;
    }
    const structuredTitle = firstCompleteBoldElement(part);
    if (structuredTitle !== null) {
      return normalizeReasoningTitle(structuredTitle);
    }
    if (state === "completed") {
      return firstPlainReasoningLine(part);
    }
  }
  return null;
}

export function commandActivityTitle(
  command: string,
  status: ActivityStatus,
  expanded: boolean,
  messages: TimelineMessages,
): string {
  if (expanded) {
    return activityStateTitle("command", status, messages);
  }
  switch (status) {
    case "completed":
      return formatMessage(messages.executedCommand, { command });
    case "declined":
      return formatMessage(messages.commandDeclinedWithValue, { command });
    case "failed":
      return formatMessage(messages.commandFailedWithValue, { command });
    case "inProgress":
      return messages.commandRunning;
  }
}

export function commandHeadline(
  command: string,
  status: ActivityStatus,
  expanded: boolean,
  runningDuration: string | null,
  messages: TimelineMessages,
): string {
  const fallback = commandActivityTitle(command, status, expanded, messages);
  return status === "inProgress"
    ? runningCommandHeadline(runningDuration, fallback, messages)
    : fallback;
}

export function shouldShowCommandDurationSuffix(status: ActivityStatus): boolean {
  return status !== "inProgress";
}

export function visibleCommandDurationMs(
  status: ActivityStatus,
  startedAt: number | null,
  durationMs: number | null,
  now: number,
): number | null {
  const elapsed =
    status === "inProgress"
      ? startedAt === null
        ? null
        : Math.max(0, now - startedAt)
      : durationMs;
  return elapsed !== null && elapsed >= LONG_COMMAND_DURATION_THRESHOLD_MS ? elapsed : null;
}

export function toolActivityTitle(
  description: string,
  status: ActivityStatus,
  expanded: boolean,
  messages: TimelineMessages,
): string {
  if (status === "inProgress") {
    return expanded ? messages.executingTool : description;
  }
  if (!expanded) {
    return status === "completed"
      ? formatMessage(messages.executedTool, { description })
      : activityFailureTitle(description, status, messages);
  }
  return activityStateTitle("tool", status, messages);
}

export function commandPollActivityTitle(
  status: ActivityStatus,
  messages: TimelineMessages,
): string {
  switch (status) {
    case "completed":
      return messages.commandVerified;
    case "declined":
      return messages.commandCheckDeclined;
    case "failed":
      return messages.commandCheckFailed;
    case "inProgress":
      return messages.checkingCommand;
  }
}

export function terminalReadActivityTitle(
  status: ActivityStatus,
  messages: TimelineMessages,
): string {
  switch (status) {
    case "completed":
      return messages.terminalRead;
    case "declined":
      return messages.terminalReadDeclined;
    case "failed":
      return messages.terminalReadFailed;
    case "inProgress":
      return messages.readingTerminal;
  }
}

export function fileReadActivityTitle(
  status: ActivityStatus,
  messages: TimelineMessages,
  count?: number,
): string {
  const target = fileReadTarget(count, messages);
  switch (status) {
    case "completed": {
      if (count === undefined) {
        return messages.readFile;
      }
      return count === 1 ? messages.readOneFile : messages.readFiles;
    }
    case "declined":
      return formatMessage(messages.fileReadDeclined, { target });
    case "failed":
      return formatMessage(messages.fileReadFailed, { target });
    case "inProgress":
      return formatMessage(messages.readingFiles, { target });
  }
}

export function fileReadItemTitle(
  status: ActivityStatus,
  name: string,
  messages: TimelineMessages,
): string {
  const base = fileReadActivityTitle(status, messages);
  return status === "completed"
    ? formatMessage(messages.fileItemRead, { name })
    : formatMessage(messages.fileItemStatus, { name, status: base });
}

export function fileChangeGroupTitle(changeCount: number, messages: TimelineMessages): string {
  return changeCount === 1
    ? messages.oneChangedFile
    : formatMessage(messages.manyChangedFiles, { count: changeCount });
}

export function fileChangeActionLabel(
  kind: FileChange["kind"]["type"],
  messages: TimelineMessages,
): string {
  switch (kind) {
    case "add":
      return messages.fileCreated;
    case "delete":
      return messages.fileDeleted;
    case "update":
      return messages.fileEdited;
  }
}

export function commandOutputText(output: string | null | undefined): string | null {
  if (typeof output !== "string" || output.length === 0) {
    return null;
  }
  const header = /^exit_code:\s*-?\d+\r?\nstdout:\r?\n/u.exec(output);
  if (header === null) {
    return output;
  }
  const body = output.slice(header[0].length);
  const stderrMarker = /\r?\nstderr:\r?\n/gu;
  let marker: RegExpExecArray | null = null;
  for (let match = stderrMarker.exec(body); match !== null; match = stderrMarker.exec(body)) {
    marker = match;
  }
  if (marker === null) {
    const partial = body.trimEnd();
    return partial.length > 0 ? partial : null;
  }
  const stdout = body.slice(0, marker.index).trimEnd();
  const stderr = body.slice(marker.index + marker[0].length).trimEnd();
  const visible = [stdout, stderr].filter(Boolean).join("\n");
  return visible.length > 0 ? visible : null;
}

export function commandLiveOutputText(
  output: CommandLiveOutput | null,
  messages: TimelineMessages,
): string | null {
  if (output === null) {
    return null;
  }
  const sections: string[] = [];
  if (output.stdout.length > 0) {
    sections.push(output.stderr.length > 0 ? `stdout:\n${output.stdout}` : output.stdout);
  }
  if (output.stderr.length > 0) {
    sections.push(`stderr:\n${output.stderr}`);
  }
  if (output.truncated) {
    sections.push(messages.limitedLivePreview);
  }
  return sections.length === 0 ? null : sections.join("\n");
}

export function toolOutputText(output: string | null | undefined): string | null {
  return typeof output === "string" && output.length > 0 ? output : null;
}

export function userMessageMarkerWidth(index: number, interactionIndex: number | null): number {
  if (interactionIndex === null) {
    return USER_MESSAGE_PROXIMITY_WEIGHTS.minimum;
  }
  switch (Math.abs(index - interactionIndex)) {
    case 0:
      return USER_MESSAGE_PROXIMITY_WEIGHTS.current;
    case 1:
      return USER_MESSAGE_PROXIMITY_WEIGHTS.adjacent;
    case 2:
      return USER_MESSAGE_PROXIMITY_WEIGHTS.nearby;
    case 3:
      return USER_MESSAGE_PROXIMITY_WEIGHTS.remote;
    default:
      return USER_MESSAGE_PROXIMITY_WEIGHTS.minimum;
  }
}

function firstCompleteBoldElement(value: string): string | null {
  const openingMarker = value.indexOf("**");
  if (openingMarker === -1) {
    return null;
  }
  const contentStart = openingMarker + 2;
  const closingMarker = value.indexOf("**", contentStart);
  if (closingMarker === -1) {
    return null;
  }
  const content = value.slice(contentStart, closingMarker).trim();
  return content.length === 0 ? null : content;
}

function firstPlainReasoningLine(value: string): string | null {
  for (const sourceLine of value.split(/\r?\n/u)) {
    const line = sourceLine.trim();
    if (line.length > 0) {
      const withoutMarkdown = line
        .replace(/^#{1,6}\s+/u, "")
        .replace(/^\*{1,2}/u, "")
        .replace(/\*{1,2}$/u, "");
      const title = normalizeReasoningTitle(withoutMarkdown);
      return title.length === 0 ? null : title;
    }
  }
  return null;
}

function normalizeReasoningTitle(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function activityStateTitle(
  kind: "command" | "tool",
  status: ActivityStatus,
  messages: TimelineMessages,
): string {
  const tool = kind === "tool";
  switch (status) {
    case "completed":
      return tool ? messages.toolExecuted : messages.commandExecuted;
    case "declined":
      return tool ? messages.toolDeclined : messages.commandDeclined;
    case "failed":
      return tool ? messages.toolFailed : messages.commandFailed;
    case "inProgress":
      return tool ? messages.executingTool : messages.executingCommand;
  }
}

function fileReadTarget(count: number | undefined, messages: TimelineMessages): string {
  if (count === undefined) {
    return messages.file;
  }
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError(`The file-read count must be a positive integer; received ${count}.`);
  }
  return count === 1 ? messages.oneFile : formatMessage(messages.manyFiles, { count });
}

function activityFailureTitle(
  label: string,
  status: Exclude<ActivityStatus, "completed" | "inProgress">,
  messages: TimelineMessages,
): string {
  return formatMessage(
    status === "declined" ? messages.declinedActivity : messages.failedActivity,
    { description: label },
  );
}
