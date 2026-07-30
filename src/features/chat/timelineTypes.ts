import type { Attachment } from "../../shared/codex/types";

export type ActivityStatus =
  | "completed"
  | "declined"
  | "failed"
  | "inProgress";

export interface MessageEntry {
  type: "message";
  id: string;
  role: "assistant" | "user";
  text: string;
  attachments: Attachment[];
  phase: string | null;
  status: "complete" | "failed" | "streaming";
}

export interface ReasoningEntry {
  type: "reasoning";
  id: string;
  summary: string[];
  content: string[];
  status: "completed" | "inProgress";
}

export interface PlanEntry {
  type: "plan";
  id: string;
  text: string;
  status: "completed" | "inProgress";
}

export type CommandSource =
  | "agent"
  | "unifiedExecInteraction"
  | "unifiedExecStartup"
  | "userShell";

export interface CommandEntry {
  type: "command";
  id: string;
  command: string;
  cwd: string;
  processId: string | null;
  source: CommandSource;
  status: ActivityStatus;
  output: string;
  outputOmittedCharacters: number;
  exitCode: number | null;
  durationMs: number | null;
  terminalInput: string[];
}

export type FileChangeKind = "add" | "delete" | "update";

export interface FileChange {
  path: string;
  kind: FileChangeKind;
  movePath: string | null;
  diff: string;
}

export interface FileChangeEntry {
  type: "fileChange";
  id: string;
  changes: FileChange[];
  status: ActivityStatus;
}

export interface ImageViewEntry {
  type: "imageView";
  id: string;
  path: string;
  status: ActivityStatus;
}

export type ToolKind =
  | "collaboration"
  | "dynamic"
  | "mcp"
  | "other";

export interface ToolEntry {
  type: "tool";
  id: string;
  kind: ToolKind;
  name: string;
  detail: string | null;
  status: ActivityStatus;
}

export interface ActivityEntry {
  type: "activity";
  id: string;
  label: string;
  detail: string | null;
  status: ActivityStatus;
}

export type GroupableTimelineEntry =
  | ActivityEntry
  | CommandEntry
  | FileChangeEntry
  | ImageViewEntry
  | ToolEntry;

export type TimelineEntry =
  | GroupableTimelineEntry
  | MessageEntry
  | PlanEntry
  | ReasoningEntry;

export function isGroupableTimelineEntry(
  entry: TimelineEntry,
): entry is GroupableTimelineEntry {
  return (
    entry.type === "activity" ||
    entry.type === "command" ||
    entry.type === "fileChange" ||
    entry.type === "imageView" ||
    entry.type === "tool"
  );
}
