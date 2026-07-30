import {
  isJsonObject,
  readString,
  type JsonObject,
  type JsonValue,
} from "../../shared/codex/types";
import {
  parseAgentMessageItem,
  parseCommandItem,
  parseFileChangeItem,
  parseImageViewItem,
  parsePlanItem,
  parseReasoningItem,
} from "./parseCoreTimelineItem";
import {
  parseHookPromptItem,
  parseImageGenerationItem,
  parseReviewItem,
  parseSleepItem,
  parseWebSearchItem,
} from "./parseSpecialTimelineItem";
import {
  parseAgentToolItem,
  parseSubAgentActivityItem,
  parseToolItem,
} from "./parseToolItem";
import { parseUserMessage } from "./parseUserMessage";
import {
  lifecycleStatus,
  type ParseResult,
} from "./timelineParsing";
import type { ActivityEntry, TimelineEntry } from "./timelineTypes";

const THREAD_ITEM_TYPES = [
  "agentMessage",
  "collabAgentToolCall",
  "commandExecution",
  "contextCompaction",
  "dynamicToolCall",
  "enteredReviewMode",
  "exitedReviewMode",
  "fileChange",
  "hookPrompt",
  "imageGeneration",
  "imageView",
  "mcpToolCall",
  "plan",
  "reasoning",
  "sleep",
  "subAgentActivity",
  "userMessage",
  "webSearch",
] as const;

type ThreadItemType = (typeof THREAD_ITEM_TYPES)[number];

const THREAD_ITEM_TYPE_SET = new Set<string>(THREAD_ITEM_TYPES);

export type TimelineItemParseResult =
  | { ok: true; entry: TimelineEntry }
  | { ok: false; error: string };

export function parseTimelineItem(
  value: JsonValue,
  completed: boolean,
): TimelineItemParseResult {
  if (!isJsonObject(value)) {
    return { ok: false, error: "A tarefa retornou um item que não é um objeto." };
  }
  const rawType = readString(value, "type");
  const id = readString(value, "id");
  if (rawType === undefined || id === undefined) {
    return {
      ok: false,
      error: "A tarefa retornou um item sem tipo ou identificador.",
    };
  }
  if (!THREAD_ITEM_TYPE_SET.has(rawType)) {
    return {
      ok: false,
      error: `O app-server retornou o tipo de item desconhecido ${rawType}.`,
    };
  }

  return parseKnownTimelineItem(rawType as ThreadItemType, id, value, completed);
}

function parseKnownTimelineItem(
  type: ThreadItemType,
  id: string,
  item: JsonObject,
  completed: boolean,
): TimelineItemParseResult {
  switch (type) {
    case "userMessage":
      return parseUserMessage(id, item);
    case "hookPrompt":
      return timelineResult(parseHookPromptItem(id, item, completed));
    case "agentMessage":
      return timelineResult(parseAgentMessageItem(id, item, completed));
    case "reasoning":
      return timelineResult(parseReasoningItem(id, item, completed));
    case "plan":
      return timelineResult(parsePlanItem(id, item, completed));
    case "commandExecution":
      return timelineResult(parseCommandItem(id, item));
    case "fileChange":
      return timelineResult(parseFileChangeItem(id, item));
    case "mcpToolCall":
      return timelineResult(parseToolItem(id, item, "mcp"));
    case "dynamicToolCall":
      return timelineResult(parseToolItem(id, item, "dynamic"));
    case "collabAgentToolCall":
      return timelineResult(parseAgentToolItem(id, item));
    case "subAgentActivity":
      return timelineResult(parseSubAgentActivityItem(id, item, completed));
    case "webSearch":
      return timelineResult(parseWebSearchItem(id, item, completed));
    case "imageView":
      return timelineResult(parseImageViewItem(id, item, completed));
    case "sleep":
      return timelineResult(parseSleepItem(id, item, completed));
    case "imageGeneration":
      return timelineResult(parseImageGenerationItem(id, item, completed));
    case "enteredReviewMode":
      return timelineResult(parseReviewItem(id, item, "entered"));
    case "exitedReviewMode":
      return timelineResult(parseReviewItem(id, item, "exited"));
    case "contextCompaction":
      return {
        ok: true,
        entry: activity(
          id,
          "Contexto compactado automaticamente",
          null,
          completed,
        ),
      };
  }
}

function activity(
  id: string,
  label: string,
  detail: string | null,
  completed: boolean,
): ActivityEntry {
  return {
    type: "activity",
    id,
    label,
    detail,
    status: lifecycleStatus(completed),
  };
}

function timelineResult<T extends TimelineEntry>(
  result: ParseResult<T>,
): TimelineItemParseResult {
  return result.ok
    ? { ok: true, entry: result.value }
    : { ok: false, error: result.error };
}
