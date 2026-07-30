import {
  isGroupableTimelineEntry,
  type ActivityStatus,
  type GroupableTimelineEntry,
  type MessageEntry,
  type PlanEntry,
  type ReasoningEntry,
  type TimelineEntry,
} from "./timelineTypes";

export type TimelineBlock =
  | {
      type: "activityGroup";
      id: string;
      entries: GroupableTimelineEntry[];
      header: ActivityGroupHeader;
      reasoning: ReasoningEntry | null;
      status: ActivityStatus;
    }
  | {
      type: "entry";
      id: string;
      entry: MessageEntry | PlanEntry;
    }
  | {
      type: "liveActivity";
      id: string;
      entry: GroupableTimelineEntry;
    };

export interface ActivityGroupHeader {
  kind: "activity" | "reasoning";
  label: string;
}

export function buildTimelineBlocks(entries: TimelineEntry[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  let pendingGroup: GroupableTimelineEntry[] = [];
  let pendingCommentary: MessageEntry[] = [];
  let pendingReasoning: ReasoningEntry | null = null;

  const flushGroup = () => {
    if (pendingGroup.length === 0) {
      if (pendingReasoning !== null) {
        blocks.push({
          type: "activityGroup",
          id: `activity-group:${pendingReasoning.id}`,
          entries: [],
          header: activityGroupHeader([], pendingReasoning),
          reasoning: pendingReasoning,
          status: aggregateStatus([], pendingReasoning),
        });
        pendingReasoning = null;
      }
      blocks.push(
        ...pendingCommentary.map((entry) => ({
          type: "entry" as const,
          id: entry.id,
          entry,
        })),
      );
      pendingCommentary = [];
      return;
    }
    const first = pendingGroup[0];
    if (first === undefined) {
      return;
    }
    blocks.push({
      type: "activityGroup",
      id: `activity-group:${pendingReasoning?.id ?? first.id}`,
      entries: pendingGroup,
      header: activityGroupHeader(pendingGroup, pendingReasoning),
      reasoning: pendingReasoning,
      status: aggregateStatus(pendingGroup, pendingReasoning),
    });
    pendingGroup = [];
    pendingReasoning = null;
  };

  for (const entry of entries) {
    if (entry.type === "reasoning") {
      if (pendingGroup.length > 0 || pendingCommentary.length > 0) {
        flushGroup();
      }
      pendingReasoning =
        pendingReasoning === null
          ? entry
          : mergeConsecutiveReasoning(pendingReasoning, entry);
      continue;
    }
    if (!isGroupableTimelineEntry(entry)) {
      if (
        pendingReasoning !== null &&
        pendingGroup.length === 0 &&
        entry.type === "message" &&
        entry.role === "assistant"
      ) {
        pendingCommentary.push(entry);
        continue;
      }
      flushGroup();
      blocks.push({ type: "entry", id: entry.id, entry });
      continue;
    }
    if (
      entry.status === "inProgress" &&
      pendingReasoning === null &&
      pendingGroup.length === 0
    ) {
      flushGroup();
      blocks.push({ type: "liveActivity", id: entry.id, entry });
      continue;
    }
    if (pendingGroup.length === 0 && pendingCommentary.length > 0) {
      blocks.push(
        ...pendingCommentary.map((commentary) => ({
          type: "entry" as const,
          id: commentary.id,
          entry: commentary,
        })),
      );
      pendingCommentary = [];
    }
    pendingGroup.push(entry);
  }
  flushGroup();
  return blocks;
}

function mergeConsecutiveReasoning(
  current: ReasoningEntry,
  next: ReasoningEntry,
): ReasoningEntry {
  return {
    ...next,
    id: current.id,
    summary: [...current.summary, ...next.summary],
    content: [...current.content, ...next.content],
  };
}

export function activityGroupHeader(
  entries: GroupableTimelineEntry[],
  reasoning: ReasoningEntry | null = null,
): ActivityGroupHeader {
  if (
    reasoning !== null &&
    (entries.length === 0 ||
      reasoning.status === "inProgress" ||
      entries.some(({ status }) => status === "inProgress"))
  ) {
    const reasoningLabel = reasoningText(reasoning);
    return { kind: "reasoning", label: reasoningLabel || "Pensando" };
  }
  const fileCount = entries.reduce(
    (count, entry) =>
      entry.type === "fileChange"
        ? count + Math.max(1, entry.changes.length)
        : count,
    0,
  );
  const commandCount = entries.filter((entry) => entry.type === "command").length;
  const imageCount = entries.filter((entry) => entry.type === "imageView").length;
  const tools = entries.filter((entry) => entry.type === "tool");
  const activities = entries.filter((entry) => entry.type === "activity");
  const phrases: string[] = [];

  if (fileCount > 0) {
    phrases.push(fileCount === 1 ? "Editou um arquivo" : "Editou arquivos");
  }
  if (commandCount > 0) {
    phrases.push(
      commandCount === 1 ? "Executou um comando" : "Executou comandos",
    );
  }
  if (imageCount > 0) {
    phrases.push(
      imageCount === 1 ? "Visualizou uma imagem" : `Visualizou ${imageCount} imagens`,
    );
  }
  if (tools.length > 0) {
    phrases.push(
      tools.length === 1 ? (tools[0]?.name ?? "Usou uma ferramenta") : "Usou ferramentas",
    );
  }
  if (activities.length > 0) {
    phrases.push(
      activities.length === 1
        ? (activities[0]?.label ?? "Executou uma ação")
        : "Executou outras ações",
    );
  }

  if (phrases.length === 0) {
    return { kind: "activity", label: "Executou ações" };
  }
  return {
    kind: "activity",
    label: phrases
      .map((phrase, index) => (index === 0 ? phrase : lowerInitial(phrase)))
      .join(" e "),
  };
}

function aggregateStatus(
  entries: GroupableTimelineEntry[],
  reasoning: ReasoningEntry | null,
): ActivityStatus {
  if (entries.some(({ status }) => status === "failed")) {
    return "failed";
  }
  if (entries.some(({ status }) => status === "declined")) {
    return "declined";
  }
  if (
    reasoning?.status === "inProgress" ||
    entries.some(({ status }) => status === "inProgress")
  ) {
    return "inProgress";
  }
  return "completed";
}

function reasoningText(reasoning: ReasoningEntry): string {
  const value = [...reasoning.content, ...reasoning.summary]
    .findLast((part) => part.trim().length > 0)
    ?.trim();
  return (value ?? "")
    .replace(/^#{1,6}\s+/, "")
    .replaceAll("**", "")
    .replaceAll("__", "")
    .split("\n")[0]
    ?.trim() ?? "";
}

function lowerInitial(value: string): string {
  return `${value[0]?.toLocaleLowerCase("pt-BR") ?? ""}${value.slice(1)}`;
}
