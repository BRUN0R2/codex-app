export type ActivityStatus =
  | "completed"
  | "declined"
  | "failed"
  | "inProgress";

export type ImageDetail = "auto" | "high" | "low" | "original" | null;

export type MessageAttachment =
  | {
      kind: "localImage";
      id: string;
      name: string;
      path: string;
      mediaType: string | null;
      detail: ImageDetail;
    }
  | {
      kind: "remoteImage";
      id: string;
      source: string;
      embedded: boolean;
      detail: ImageDetail;
    }
  | {
      kind: "localAudio";
      id: string;
      name: string;
      path: string;
    }
  | {
      kind: "remoteAudio";
      id: string;
      source: string;
      embedded: boolean;
    }
  | {
      kind: "mention" | "skill";
      id: string;
      name: string;
      path: string;
    };

export type MessagePhase = "commentary" | "final_answer" | null;

export interface MessageEntry {
  type: "message";
  id: string;
  role: "assistant" | "user";
  text: string;
  attachments: MessageAttachment[];
  phase: MessagePhase;
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

export type ToolKind = "dynamic" | "mcp";

export interface ToolEntry {
  type: "tool";
  id: string;
  kind: ToolKind;
  name: string;
  provider: string | null;
  detail: string | null;
  progress: string[];
  readOnly: boolean | null;
  durationMs: number | null;
  status: ActivityStatus;
}

export type AgentToolAction =
  | "closeAgent"
  | "resumeAgent"
  | "sendInput"
  | "spawnAgent"
  | "wait";

export interface AgentState {
  threadId: string;
  status: string;
  message: string | null;
}

export interface AgentToolEntry {
  type: "agentTool";
  id: string;
  action: AgentToolAction;
  senderThreadId: string;
  receiverThreadIds: string[];
  prompt: string | null;
  model: string | null;
  reasoningEffort: string | null;
  agents: AgentState[];
  status: ActivityStatus;
}

export type SubAgentActivityKind = "interacted" | "interrupted" | "started";

export interface SubAgentActivityEntry {
  type: "subAgentActivity";
  id: string;
  kind: SubAgentActivityKind;
  agentThreadId: string;
  agentPath: string;
  status: ActivityStatus;
}

export type WebSearchAction =
  | { type: "findInPage"; source: string | null; pattern: string | null }
  | { type: "openPage"; source: string | null }
  | { type: "other" }
  | { type: "search"; queries: string[]; query: string | null };

export interface WebSearchEntry {
  type: "webSearch";
  id: string;
  query: string;
  action: WebSearchAction | null;
  resultCount: number | null;
  status: ActivityStatus;
}

export interface SleepEntry {
  type: "sleep";
  id: string;
  durationMs: number;
  status: ActivityStatus;
}

export interface ImageGenerationEntry {
  type: "imageGeneration";
  id: string;
  revisedPrompt: string | null;
  savedPath: string | null;
  resultAvailable: boolean;
  providerStatus: string;
  status: ActivityStatus;
}

export interface HookPromptFragment {
  text: string;
  hookRunId: string;
}

export interface HookPromptEntry {
  type: "hookPrompt";
  id: string;
  fragments: HookPromptFragment[];
  status: ActivityStatus;
}

export interface ReviewEntry {
  type: "review";
  id: string;
  event: "entered" | "exited";
  review: string;
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
  | AgentToolEntry
  | CommandEntry
  | FileChangeEntry
  | HookPromptEntry
  | ImageGenerationEntry
  | ImageViewEntry
  | SleepEntry
  | SubAgentActivityEntry
  | ToolEntry
  | WebSearchEntry;

export type TimelineEntry =
  | GroupableTimelineEntry
  | MessageEntry
  | PlanEntry
  | ReasoningEntry
  | ReviewEntry;

export function isGroupableTimelineEntry(
  entry: TimelineEntry,
): entry is GroupableTimelineEntry {
  return (
    entry.type === "activity" ||
    entry.type === "agentTool" ||
    entry.type === "command" ||
    entry.type === "fileChange" ||
    entry.type === "hookPrompt" ||
    entry.type === "imageGeneration" ||
    entry.type === "imageView" ||
    entry.type === "sleep" ||
    entry.type === "subAgentActivity" ||
    entry.type === "tool" ||
    entry.type === "webSearch"
  );
}
