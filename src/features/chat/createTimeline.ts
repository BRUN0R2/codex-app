import { createSignal, type Accessor } from "solid-js";

import {
  readString,
  type Attachment,
  type JsonObject,
  type JsonValue,
} from "../../shared/codex/types";
import {
  parseFileChanges,
  parseTimelineItem,
} from "./parseTimelineItem";
import { appendCommandOutput } from "./timelineText";
import type {
  MessageEntry,
  TimelineEntry,
} from "./timelineTypes";

interface TimelineOptions {
  reportProtocolError: (message: string) => void;
}

export interface TimelineController {
  entries: Accessor<TimelineEntry[]>;
  addOptimisticUserMessage: (
    id: string,
    text: string,
    attachments: Attachment[],
  ) => void;
  appendAgentDelta: (params: JsonObject | undefined) => void;
  appendCommandOutputDelta: (params: JsonObject | undefined) => void;
  appendPlanDelta: (params: JsonObject | undefined) => void;
  appendReasoningSummaryDelta: (params: JsonObject | undefined) => void;
  appendReasoningTextDelta: (params: JsonObject | undefined) => void;
  appendTerminalInteraction: (params: JsonObject | undefined) => void;
  handleItem: (value: JsonValue | undefined, completed: boolean) => void;
  hydrate: (items: JsonValue[]) => void;
  markUserMessage: (id: string, status: "complete" | "failed") => void;
  reset: () => void;
  updateFileChangePatch: (params: JsonObject | undefined) => void;
}

export function createTimeline(options: TimelineOptions): TimelineController {
  const [entries, setEntries] = createSignal<TimelineEntry[]>([]);

  function addOptimisticUserMessage(
    id: string,
    text: string,
    attachments: Attachment[],
  ) {
    upsert({
      type: "message",
      id,
      role: "user",
      text,
      attachments,
      phase: null,
      status: "streaming",
    });
  }

  function handleItem(value: JsonValue | undefined, completed: boolean) {
    if (value === undefined) {
      options.reportProtocolError("A notificação de item não contém o item esperado.");
      return;
    }
    const parsed = parseTimelineItem(value, completed);
    if (!parsed.ok) {
      options.reportProtocolError(parsed.error);
      return;
    }
    if (parsed.entry.type === "message" && parsed.entry.role === "user") {
      replaceOptimisticUserMessage(parsed.entry);
      return;
    }
    upsert(parsed.entry);
  }

  function hydrate(items: JsonValue[]) {
    const hydrated: TimelineEntry[] = [];
    for (const item of items) {
      const parsed = parseTimelineItem(item, true);
      if (parsed.ok) {
        const index = hydrated.findIndex(({ id }) => id === parsed.entry.id);
        if (index < 0) {
          hydrated.push(parsed.entry);
        } else {
          hydrated[index] = parsed.entry;
        }
      } else {
        options.reportProtocolError(parsed.error);
      }
    }
    setEntries(hydrated);
  }

  function appendAgentDelta(params: JsonObject | undefined) {
    const id = readString(params, "itemId");
    const delta = readString(params, "delta");
    if (id === undefined || delta === undefined) {
      return;
    }
    const current = entries().find((entry) => entry.id === id);
    if (current?.type === "message" && current.role === "assistant") {
      update(id, (entry) =>
        entry.type === "message" && entry.role === "assistant"
          ? { ...entry, text: `${entry.text}${delta}`, status: "streaming" }
          : entry,
      );
      return;
    }
    upsert({
      type: "message",
      id,
      role: "assistant",
      text: delta,
      attachments: [],
      phase: null,
      status: "streaming",
    });
  }

  function appendCommandOutputDelta(params: JsonObject | undefined) {
    const id = readString(params, "itemId");
    const delta = readString(params, "delta");
    if (id === undefined || delta === undefined) {
      return;
    }
    update(id, (entry) =>
      entry.type === "command"
        ? (() => {
            const output = appendCommandOutput(
              {
                text: entry.output,
                omittedCharacters: entry.outputOmittedCharacters,
              },
              delta,
            );
            return {
              ...entry,
              output: output.text,
              outputOmittedCharacters: output.omittedCharacters,
            };
          })()
        : entry,
    );
  }

  function appendPlanDelta(params: JsonObject | undefined) {
    const id = readString(params, "itemId");
    const delta = readString(params, "delta");
    if (id === undefined || delta === undefined) {
      return;
    }
    const current = entries().find((entry) => entry.id === id);
    if (current?.type === "plan") {
      update(id, (entry) =>
        entry.type === "plan"
          ? { ...entry, text: `${entry.text}${delta}`, status: "inProgress" }
          : entry,
      );
      return;
    }
    upsert({ type: "plan", id, text: delta, status: "inProgress" });
  }

  function appendReasoningSummaryDelta(params: JsonObject | undefined) {
    appendReasoningDelta(params, "summary", "summaryIndex");
  }

  function appendReasoningTextDelta(params: JsonObject | undefined) {
    appendReasoningDelta(params, "content", "contentIndex");
  }

  function appendReasoningDelta(
    params: JsonObject | undefined,
    field: "content" | "summary",
    indexField: "contentIndex" | "summaryIndex",
  ) {
    const id = readString(params, "itemId");
    const delta = readString(params, "delta");
    const index = readIndex(params?.[indexField]);
    if (id === undefined || delta === undefined || index === null) {
      return;
    }
    const current = entries().find((entry) => entry.id === id);
    if (current?.type !== "reasoning") {
      upsert({
        type: "reasoning",
        id,
        summary: field === "summary" ? writeIndexed([], index, delta) : [],
        content: field === "content" ? writeIndexed([], index, delta) : [],
        status: "inProgress",
      });
      return;
    }
    update(id, (entry) =>
      entry.type === "reasoning"
        ? {
            ...entry,
            [field]: writeIndexed(entry[field], index, delta),
            status: "inProgress",
          }
        : entry,
    );
  }

  function appendTerminalInteraction(params: JsonObject | undefined) {
    const id = readString(params, "itemId");
    const stdin = readString(params, "stdin");
    if (id === undefined || stdin === undefined) {
      return;
    }
    update(id, (entry) =>
      entry.type === "command"
        ? { ...entry, terminalInput: [...entry.terminalInput, stdin] }
        : entry,
    );
  }

  function updateFileChangePatch(params: JsonObject | undefined) {
    const id = readString(params, "itemId");
    if (id === undefined) {
      return;
    }
    const changes = parseFileChanges(params?.changes);
    update(id, (entry) =>
      entry.type === "fileChange" ? { ...entry, changes } : entry,
    );
  }

  function markUserMessage(id: string, status: "complete" | "failed") {
    update(id, (entry) =>
      entry.type === "message" && entry.role === "user"
        ? { ...entry, status }
        : entry,
    );
  }

  function replaceOptimisticUserMessage(replacement: MessageEntry) {
    const optimistic = entries().find(
      (entry) =>
        entry.type === "message" &&
        entry.role === "user" &&
        entry.status === "streaming",
    );
    if (optimistic?.type === "message" && optimistic.id !== replacement.id) {
      setEntries((current) =>
        current.map((entry) =>
          entry.id === optimistic.id
            ? {
                ...replacement,
                attachments:
                  replacement.attachments.length > 0
                    ? replacement.attachments
                    : optimistic.attachments,
              }
            : entry,
        ),
      );
      return;
    }
    upsert(replacement);
  }

  function upsert(entry: TimelineEntry) {
    setEntries((current) => {
      const index = current.findIndex(({ id }) => id === entry.id);
      if (index < 0) {
        return [...current, entry];
      }
      const existing = current[index];
      const next = [...current];
      if (
        existing?.type === "message" &&
        entry.type === "message" &&
        existing.attachments.length > 0 &&
        entry.attachments.length === 0
      ) {
        next[index] = { ...entry, attachments: existing.attachments };
      } else {
        next[index] = entry;
      }
      return next;
    });
  }

  function update(
    id: string,
    updateEntry: (entry: TimelineEntry) => TimelineEntry,
  ) {
    setEntries((current) =>
      current.map((entry) => (entry.id === id ? updateEntry(entry) : entry)),
    );
  }

  return {
    entries,
    addOptimisticUserMessage,
    appendAgentDelta,
    appendCommandOutputDelta,
    appendPlanDelta,
    appendReasoningSummaryDelta,
    appendReasoningTextDelta,
    appendTerminalInteraction,
    handleItem,
    hydrate,
    markUserMessage,
    reset: () => setEntries([]),
    updateFileChangePatch,
  };
}

function readIndex(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function writeIndexed(values: string[], index: number, delta: string): string[] {
  const next = [...values];
  while (next.length <= index) {
    next.push("");
  }
  next[index] = `${next[index] ?? ""}${delta}`;
  return next;
}
